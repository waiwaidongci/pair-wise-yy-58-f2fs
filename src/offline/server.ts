import { affectedCommentIds, diffNewRisks } from './rules';
import { BASE_REVISION, PLAN_ID, PLAN_NAME, seedComments, seedReviewers, seedSteps } from './seed';
import type {
  BlockedChange,
  CommentAddChange,
  CommentRecord,
  CommentResolveChange,
  CommitResultDTO,
  FieldConflict,
  FinalizeResultDTO,
  PlanStateDTO,
  Reviewer,
  ServerMeta,
  StepFieldChange,
  StepParams,
  SyncBatch
} from './types';
import { NUMERIC_FIELDS } from './types';

const SERVER_KEY = 'yy58-lift-plan-server';
const LATENCY_MS = 420;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalize(field: keyof StepParams, value: string | number): string | number {
  return NUMERIC_FIELDS.includes(field as never) ? Number(value) : String(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a) === String(b);
}

function nowIso(): string {
  return new Date().toISOString();
}

interface ServerState {
  plan: PlanStateDTO;
  /**
   * 字段级锁定：锁定内容在合并时拒绝覆盖
   */
  lockedFields: { stepId: string; field: StepFieldChange['field'] }[];
  /** 已入库变更 id，保证幂等：重试不重复写入 */
  appliedChangeIds: string[];
  finalizedBatchIds: Record<string, FinalizeResultDTO>;
  /** 每次步骤字段入库后的版本快照，按 revision 索引，用于按批次基线重建三方比对基准 */
  revisionHistory: { revision: number; steps: StepParams[] }[];
  /** 故障注入：接下来多少次提交 / 完成请求强制失败 */
  failNextCommits: number;
  failNextFinalizes: number;
}

function initialState(): ServerState {
  return {
    plan: {
      id: PLAN_ID,
      name: PLAN_NAME,
      revision: BASE_REVISION,
      status: 'REVIEW',
      steps: clone(seedSteps),
      comments: clone(seedComments),
      reviewers: clone(seedReviewers),
      signOff: { valid: false, revision: BASE_REVISION }
    },
    lockedFields: [],
    appliedChangeIds: [],
    finalizedBatchIds: {},
    revisionHistory: [{ revision: BASE_REVISION, steps: clone(seedSteps) }],
    failNextCommits: 0,
    failNextFinalizes: 0
  };
}

function loadState(): ServerState {
  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SERVER_KEY) : null;
  if (raw) {
    try {
      return { ...initialState(), ...(JSON.parse(raw) as ServerState) };
    } catch {
      /* 损坏时回落到初始态 */
    }
  }
  return initialState();
}

function delay<T>(value: T, latency = LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(clone(value)), latency));
}

/**
 * 模拟服务端：真正的字段级三方合并在这里完成，本地只负责编排与重试。
 * 所有写接口均幂等，同一批可安全重试。
 */
class MockPlanServer {
  private state: ServerState;

  constructor() {
    this.state = loadState();
  }

  private persist(): void {
    localStorage.setItem(SERVER_KEY, JSON.stringify(this.state));
  }

  /** 留存当前版本步骤快照，供旧基线批次重放三方比对基准。 */
  private recordHistory(): void {
    const revision = this.state.plan.revision;
    const index = this.state.revisionHistory.findIndex((entry) => entry.revision === revision);
    const snapshot = { revision, steps: clone(this.state.plan.steps) };
    if (index >= 0) this.state.revisionHistory[index] = snapshot;
    else {
      this.state.revisionHistory.push(snapshot);
      this.state.revisionHistory.sort((a, b) => a.revision - b.revision);
    }
  }

  private snapshot(): PlanStateDTO {
    return clone(this.state.plan);
  }

  private fieldLocked(stepId: string, field: StepFieldChange['field']): boolean {
    return this.state.lockedFields.some((item) => item.stepId === stepId && item.field === field);
  }

  async getMeta(): Promise<ServerMeta> {
    return delay({
      revision: this.state.plan.revision,
      status: this.state.plan.status,
      lockedFields: clone(this.state.lockedFields),
      signOff: clone(this.state.plan.signOff)
    }, 180);
  }

  async pull(): Promise<PlanStateDTO> {
    return delay(this.snapshot());
  }

  /**
   * 提交一个离线批次：对每条 stepField 改动做「基线 / 现场 / 当前锁定版本」逐字段合并。
   * - 服务端未动该字段 → 干净改动直接入库
   * - 服务端改成别的值 → 冲突，等人工选择（携带 resolution 后落地）
   * - 字段已锁定或方案已锁定发布 → 拒绝覆盖（blocked），计入幂等但不改服务端值
   * 意见类改动直接幂等入库。已入库改动重试时直接回显，不重复写入。
   */
  async commitBatch(batch: SyncBatch): Promise<CommitResultDTO> {
    if (this.state.failNextCommits > 0) {
      this.state.failNextCommits -= 1;
      this.persist();
      await delay(null);
      throw new Error('同步链路中断（模拟故障），批次已保留，稍后自动重试');
    }

    const plan = this.state.plan;
    const planLocked = plan.status === 'LOCKED';

    // 三方比对基准：优先取批次基线版本对应的服务端快照（基线落后时仍能逐字段合并），
    // 取不到时回落到批次自带基线。
    const historical = [...this.state.revisionHistory]
      .filter((entry) => entry.revision <= batch.baseRevision)
      .sort((a, b) => b.revision - a.revision)[0];
    const baseSteps = historical?.steps ?? batch.baselineSteps;

    const applied: string[] = [];
    const conflicts: FieldConflict[] = [];
    const blocked: BlockedChange[] = [];

    const carryConflict = (changeId: string): FieldConflict | undefined =>
      batch.conflicts.find((item) => item.changeId === changeId);

    for (const change of batch.changes) {
      // 幂等：已成功入库的字段不重复处理
      if (this.state.appliedChangeIds.includes(change.id)) {
        applied.push(change.id);
        continue;
      }

      if (change.type === 'stepField') {
        const step = plan.steps.find((item) => item.id === change.stepId);
        if (!step) continue;

        if (planLocked || this.fieldLocked(change.stepId, change.field)) {
          blocked.push({
            changeId: change.id,
            stepId: change.stepId,
            field: change.field,
            reason: planLocked
              ? `方案已在 V${plan.revision} 锁定发布，锁定内容不能被覆盖`
              : `字段「${change.stepId}.${change.field}」已被会签锁定，离线改动不得覆盖`
          });
          this.state.appliedChangeIds.push(change.id);
          applied.push(change.id);
          continue;
        }

        const baseStep =
          baseSteps.find((item) => item.id === change.stepId) ??
          batch.baselineSteps.find((item) => item.id === change.stepId);
        const baselineValue = baseStep ? baseStep[change.field] : change.baselineValue;
        const serverValue = step[change.field];
        const localValue = normalize(change.field, change.value);
        const carried = carryConflict(change.id);

        // 重试/解决冲突时携带了人工选择
        if (carried?.resolution) {
          if (carried.resolution === 'local') step[change.field] = localValue as never;
          this.state.appliedChangeIds.push(change.id);
          applied.push(change.id);
          continue;
        }

        if (sameValue(serverValue, localValue)) {
          // 服务端值与现场值一致（可能是此前重试已入库），幂等成功
          this.state.appliedChangeIds.push(change.id);
          applied.push(change.id);
          continue;
        }

        if (sameValue(serverValue, baselineValue)) {
          // 服务端未动过该字段：干净改动直接入库
          step[change.field] = localValue as never;
          this.state.appliedChangeIds.push(change.id);
          applied.push(change.id);
        } else {
          // 双方都改了同一字段：冲突，列给人选择
          conflicts.push({
            changeId: change.id,
            stepId: change.stepId,
            field: change.field,
            baselineValue: baselineValue as string | number,
            localValue,
            serverValue: serverValue as string | number
          });
        }
      } else if (change.type === 'commentAdd') {
        this.applyCommentAdd(change);
        this.state.appliedChangeIds.push(change.id);
        applied.push(change.id);
      } else if (change.type === 'commentResolve') {
        this.applyCommentResolve(change);
        this.state.appliedChangeIds.push(change.id);
        applied.push(change.id);
      }
    }

    // 冲突期间意见直接幂等进入方案，最终完成时只处理风险与版本
    this.persist();
    return delay({ plan: this.snapshot(), appliedChangeIds: applied, conflicts, blocked });
  }

  private applyCommentAdd(change: CommentAddChange): CommentRecord {
    const existing = this.state.plan.comments.find((c) => c.clientChangeId === change.id);
    if (existing) return existing;
    const comment: CommentRecord = {
      id: change.localCommentId,
      author: change.author,
      role: change.role,
      content: change.content,
      status: 'open',
      stepId: change.stepId,
      createdAt: change.createdAt,
      clientChangeId: change.id
    };
    this.state.plan.comments.unshift(comment);
    return comment;
  }

  private applyCommentResolve(change: CommentResolveChange): void {
    const target =
      this.state.plan.comments.find((c) => c.id === change.commentId) ??
      this.state.plan.comments.find((c) => c.clientChangeId === change.commentId);
    if (target && target.status === 'open') target.status = 'resolved';
  }

  /**
   * 完成批次合并：要求冲突全部有选择。逐字段落地后重算净空 / 荷载率风险；
   * 若合并引入新风险，原会签结论失效、相关意见重新打开，并产出新方案版本与快照。
   * 幂等：同一批次重复完成返回首次结果。
   */
  async finalizeBatch(batch: SyncBatch): Promise<FinalizeResultDTO> {
    const cached = this.state.finalizedBatchIds[batch.id];
    if (cached) return delay(cached, 120);

    if (this.state.failNextFinalizes > 0) {
      this.state.failNextFinalizes -= 1;
      this.persist();
      await delay(null);
      throw new Error('完成合并失败（模拟故障），已入库字段保持成功状态，可重试');
    }

    if (batch.conflicts.some((item) => !item.resolution)) {
      throw new Error('仍有字段冲突未选择');
    }

    const plan = this.state.plan;

    // 落地本批的意见（提交阶段已幂等入库，此处重试同样安全）
    for (const change of batch.changes) {
      if (change.type === 'commentAdd') this.applyCommentAdd(change);
      if (change.type === 'commentResolve') this.applyCommentResolve(change);
    }

    // 新风险相对批次基线版本评估（三方合并的同一基准）
    const historical = [...this.state.revisionHistory]
      .filter((entry) => entry.revision <= batch.baseRevision)
      .sort((a, b) => b.revision - a.revision)[0];
    const referenceSteps = historical?.steps ?? batch.baselineSteps;
    const newFindings = diffNewRisks(referenceSteps, plan.steps);

    const reopenedIds: string[] = [];
    if (newFindings.length > 0) {
      const candidates = affectedCommentIds(newFindings, plan.comments);
      for (const comment of plan.comments) {
        if (candidates.includes(comment.id)) {
          comment.status = 'open';
          comment.reopenedAt = nowIso();
          comment.reopenedReason = `合并后${newFindings
            .filter((f) => f.stepId === comment.stepId)
            .map((f) => f.message)
            .join('；')}，原会签结论失效`;
          reopenedIds.push(comment.id);
        }
      }
    }

    // 有实质内容变化才产生新版本；新风险导致会签结论失效
    const changed =
      batch.changes.some((change) => change.type !== 'commentResolve') ||
      newFindings.length > 0 ||
      reopenedIds.length > 0;
    if (changed) plan.revision += 1;
    if (changed) this.recordHistory();

    const hadValidSignOff = plan.signOff.valid;
    if (newFindings.length > 0 && hadValidSignOff) {
      plan.signOff = {
        valid: false,
        revision: plan.signOff.revision,
        decidedAt: plan.signOff.decidedAt,
        invalidatedAt: nowIso(),
        reason: `V${plan.revision} 合并后净空/荷载率出现新风险，会签结论失效并重新打开相关意见`
      };
    }

    const result: FinalizeResultDTO = {
      plan: this.snapshot(),
      riskReport: {
        newFindings,
        reopenedCommentIds: reopenedIds,
        signOffInvalidated: Boolean(newFindings.length > 0 && hadValidSignOff)
      },
      revisionChanged: changed,
      snapshotId: `SNAP-${plan.id}-V${plan.revision}-${batch.id.slice(-6)}`
    };
    this.state.finalizedBatchIds[batch.id] = clone(result);
    this.persist();
    return delay(result);
  }

  // ---------- 演练控制：模拟现场之外发生的事情 ----------

  /** 正式发布门禁：满足条件时在服务端锁定当前版本 */
  async lockPlan(): Promise<PlanStateDTO> {
    if (this.state.plan.status === 'LOCKED') return delay(this.snapshot(), 120);
    this.state.plan.status = 'LOCKED';
    this.state.plan.revision += 1;
    this.recordHistory();
    this.persist();
    return delay(this.snapshot(), 260);
  }

  /** 会签另一方（如安全）在办公室修改了同一步骤字段，制造逐字段冲突 */
  async devCoworkerEdit(stepId: string, field: StepFieldChange['field'], value: string | number, author = '周工（安全）'): Promise<PlanStateDTO> {
    const step = this.state.plan.steps.find((item) => item.id === stepId);
    if (step) {
      step[field] = normalize(field, value) as never;
      step.note = `${step.note}${step.note ? '\n' : ''}[${author} 会签修订 V${this.state.plan.revision}]`;
    }
    // 会签修订形成新的评审版本，供后续批次按自身基线做三方合并
    this.state.plan.revision += 1;
    this.recordHistory();
    this.persist();
    return delay(this.snapshot(), 260);
  }

  /** 会签锁定某个字段：锁定内容不允许离线改动覆盖 */
  async devLockField(stepId: string, field: StepFieldChange['field']): Promise<ServerMeta> {
    if (!this.fieldLocked(stepId, field)) this.state.lockedFields.push({ stepId, field });
    this.persist();
    return this.getMeta();
  }

  async devUnlockField(stepId: string, field: StepFieldChange['field']): Promise<ServerMeta> {
    this.state.lockedFields = this.state.lockedFields.filter((item) => !(item.stepId === stepId && item.field === field));
    this.persist();
    return this.getMeta();
  }

  /** 四角色完成会签，结论落到当前版本 */
  async devCompleteSignOff(): Promise<PlanStateDTO> {
    const stamp = nowIso();
    this.state.plan.reviewers = this.state.plan.reviewers.map((reviewer: Reviewer) => ({
      ...reviewer,
      state: 'accepted' as const,
      signedAt: reviewer.signedAt ?? stamp
    }));
    this.state.plan.signOff = { valid: true, revision: this.state.plan.revision, decidedAt: stamp };
    this.persist();
    return delay(this.snapshot(), 260);
  }

  async devFailNext(commits: number, finalizes = 0): Promise<void> {
    this.state.failNextCommits = commits;
    this.state.failNextFinalizes = finalizes;
    this.persist();
  }

  /** 演练复位：恢复 V4 会签中基线，清掉锁定与已入库记录 */
  async devReset(): Promise<PlanStateDTO> {
    this.state = initialState();
    this.persist();
    return delay(this.snapshot(), 120);
  }
}

export const planServer = new MockPlanServer();
