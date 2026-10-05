import { defineStore } from 'pinia';
import { readSnapshotMeta, writePlanSnapshot } from './graphql';
import { planServer } from './offline/server';
import { ruleConflicts } from './offline/rules';
import { BASE_REVISION, PLAN_ID, PLAN_NAME, seedComments, seedReviewers, seedSteps } from './offline/seed';
import type {
  BatchChange,
  CommentRecord,
  FieldConflict,
  PlanStateDTO,
  Reviewer,
  ServerMeta,
  SignOffState,
  StepField,
  StepParams,
  SyncBatch
} from './offline/types';

const DRAFT_KEY = 'yy58-lift-plan-draft';
const BATCH_KEY = 'yy58-lift-plan-offline-batches';
const DEVICE_KEY = 'yy58-lift-plan-device';
const RETRY_DELAY_MS = 6000;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function sameField(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a) === String(b);
}

function loadJson<T>(key: string): T | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

interface PersistedDraft {
  steps: StepParams[];
  comments: CommentRecord[];
  reviewers: Reviewer[];
  signOff: SignOffState;
  workingRevision: number;
  serverMeta: ServerMeta;
  selectedStepId: string;
  viewBookmarks: string[];
  activeBookmark: string;
  currentUser: string;
  deviceName: string;
}

function defaultDeviceName(): string {
  const saved = loadJson<{ deviceName: string }>(DEVICE_KEY);
  if (saved?.deviceName) return saved.deviceName;
  const name = `现场平板-${Math.floor(100 + Math.random() * 900)}`;
  localStorage.setItem(DEVICE_KEY, JSON.stringify({ deviceName: name }));
  return name;
}

function initialDraft(): PersistedDraft {
  return {
    steps: clone(seedSteps),
    comments: clone(seedComments),
    reviewers: clone(seedReviewers),
    signOff: { valid: false, revision: BASE_REVISION },
    workingRevision: BASE_REVISION,
    serverMeta: {
      revision: BASE_REVISION,
      status: 'REVIEW' as const,
      lockedFields: [],
      signOff: { valid: false, revision: BASE_REVISION }
    },
    selectedStepId: 'S-02',
    viewBookmarks: ['主吊全景', '东侧障碍', '安装轴线'],
    activeBookmark: '主吊全景',
    currentUser: '王工',
    deviceName: defaultDeviceName()
  };
}

const storedDraft = loadJson<Partial<PersistedDraft>>(DRAFT_KEY);
const draft: PersistedDraft = { ...initialDraft(), ...(storedDraft ?? {}) };
// 旧版本草稿没有离线字段时，以种子为准，避免版本语义错乱
if (!storedDraft?.workingRevision) {
  draft.steps = clone(seedSteps);
  draft.comments = clone(seedComments);
  draft.reviewers = clone(seedReviewers);
}
const storedBatches = loadJson<SyncBatch[]>(BATCH_KEY) ?? [];

export const useLiftStore = defineStore('lift-plan', {
  state: () => ({
    planId: PLAN_ID,
    planName: PLAN_NAME,
    // ---- 本地工作副本（离线草稿，编辑即落到这里）----
    steps: draft.steps as StepParams[],
    comments: draft.comments as CommentRecord[],
    reviewers: draft.reviewers as Reviewer[],
    signOff: draft.signOff as SignOffState,
    selectedStepId: draft.selectedStepId,
    viewBookmarks: draft.viewBookmarks,
    activeBookmark: draft.activeBookmark,
    currentUser: draft.currentUser,
    deviceName: draft.deviceName,
    // ---- 版本 ----
    workingRevision: draft.workingRevision,
    serverMeta: draft.serverMeta as ServerMeta,
    // ---- 联网与同步 ----
    online: true,
    batches: storedBatches as SyncBatch[],
    syncing: false,
    lastMessage: '',
    lastMessageTone: 'info' as 'info' | 'positive' | 'negative' | 'warning',
    retryTimer: 0 as number | undefined,
    retryDueAt: '' as string,
    draftRecovered: false,
    serverPlan: null as PlanStateDTO | null,
    lastSnapshot: readSnapshotMeta()
  }),

  getters: {
    selectedStep(state): StepParams {
      return state.steps.find((step) => step.id === state.selectedStepId) ?? state.steps[0];
    },
    conflicts(state) {
      return ruleConflicts(state.steps);
    },
    openComments(state): CommentRecord[] {
      return state.comments.filter((comment) => comment.status === 'open');
    },
    readiness(state): number {
      const passedChecks = state.steps.filter((step) => step.status === 'passed').length;
      const commentPenalty = state.comments.filter((item) => item.status === 'open').length * 12;
      const invalidPenalty = state.signOff.valid ? 0 : 4;
      return Math.max(0, Math.min(100, Math.round((passedChecks / state.steps.length) * 100 - commentPenalty - invalidPenalty)));
    },
    locked(state): boolean {
      return state.serverMeta.status === 'LOCKED';
    },
    lockedFieldKeys(state): Set<string> {
      const set = new Set<string>();
      if (state.serverMeta.status === 'LOCKED') {
        for (const step of state.steps) {
          for (const field of ['time', 'loadRate', 'clearance', 'wind', 'radius', 'boom', 'status', 'note'] as StepField[]) {
            set.add(`${step.id}.${field}`);
          }
        }
      }
      for (const item of state.serverMeta.lockedFields) set.add(`${item.stepId}.${item.field}`);
      return set;
    },
    isFieldLocked(): (stepId: string, field: StepField) => boolean {
      return (stepId: string, field: StepField) => this.lockedFieldKeys.has(`${stepId}.${field}`);
    },
    activeBatch(state): SyncBatch | undefined {
      return state.batches.find((batch) => ['open', 'syncing', 'conflicts', 'failed'].includes(batch.status));
    },
    pendingBatches(state): SyncBatch[] {
      return state.batches.filter((batch) => ['open', 'syncing', 'conflicts', 'failed'].includes(batch.status));
    },
    finishedBatches(state): SyncBatch[] {
      return state.batches.filter((batch) => ['committed', 'abandoned'].includes(batch.status));
    },
    unresolvedConflicts(): FieldConflict[] {
      return this.activeBatch?.conflicts.filter((item) => !item.resolution) ?? [];
    },
    hasPendingRiskReport(): boolean {
      return Boolean(this.activeBatch?.riskReport?.newFindings.length);
    },
    /** 步骤、冲突、就绪度与方案快照是否指向同一版本 */
    versionCoherence(state): { coherent: boolean; detail: string; snapshotId?: string } {
      const snapshotRevision = state.lastSnapshot?.revision;
      const serverRevision = state.serverMeta.revision;
      const same = snapshotRevision === state.workingRevision && snapshotRevision === serverRevision;
      return {
        coherent: same,
        detail: same
          ? `工作副本 / 服务端锁定版本 / Apollo 快照均指向 V${state.workingRevision}`
          : `工作副本 V${state.workingRevision} · 服务端 V${serverRevision} · 快照 V${snapshotRevision ?? '—'}`,
        snapshotId: state.lastSnapshot?.snapshotId
      };
    }
  },

  actions: {
    // ================= 基础 =================
    notify(message: string, tone: 'info' | 'positive' | 'negative' | 'warning' = 'info') {
      this.lastMessage = message;
      this.lastMessageTone = tone;
    },

    selectStep(id: string) {
      this.selectedStepId = id;
      this.persistDraft();
    },

    setBookmark(name: string) {
      this.activeBookmark = name;
      if (!this.viewBookmarks.includes(name)) this.viewBookmarks.push(name);
      this.persistDraft();
    },

    setOnline(value: boolean) {
      this.online = value;
      if (value) {
        this.notify('网络已恢复，开始处理待同步批次', 'positive');
        void this.refreshMeta().then(() => this.autoSync());
      } else {
        this.notify('已进入断网模式，改动将记录为离线批次', 'warning');
      }
    },

    // ================= 离线批次记录 =================
    ensureBatch(): SyncBatch {
      const existing = this.activeBatch;
      if (existing) return existing;
      const batch: SyncBatch = {
        id: makeId('BATCH'),
        deviceName: this.deviceName,
        author: this.currentUser,
        baseRevision: this.workingRevision,
        baselineSteps: clone(this.steps),
        baselineComments: clone(this.comments),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        status: 'open',
        changes: [],
        appliedChangeIds: [],
        conflicts: [],
        blocked: [],
        attempts: 0
      };
      this.batches.unshift(batch);
      this.persistBatches();
      return batch;
    },

    /** 记录一条步骤字段改动：同批内同字段反复修改只更新现场值，基线值保持首改时不变。 */
    recordStepField(stepId: string, field: StepField, value: string | number) {
      const step = this.steps.find((item) => item.id === stepId);
      if (!step) return;
      const batch = this.ensureBatch();
      const changeKey = `${stepId}.${field}`;
      const existing = batch.changes.find(
        (change): change is Extract<BatchChange, { type: 'stepField' }> => change.type === 'stepField' && change.changeKey === changeKey
      );
      if (existing) {
        existing.value = value;
        existing.updatedAt = nowIso();
      } else {
        batch.changes.push({
          id: makeId('CHG'),
          type: 'stepField',
          changeKey,
          stepId,
          field,
          baselineValue: step[field] as string | number,
          value,
          author: this.currentUser,
          updatedAt: nowIso()
        });
      }
      batch.updatedAt = nowIso();
      // 直接写入本地工作副本，保证断网时页面可用
      (step[field] as string | number) = value;
      this.persistBatches();
      this.persistDraft();
    },

    /** 保存检查器表单：逐字段比较，值未变的字段不产生改动记录。 */
    saveStep(stepId: string, values: Partial<StepParams>) {
      const step = this.steps.find((item) => item.id === stepId);
      if (!step) return;
      let touched = 0;
      (Object.keys(values) as StepField[]).forEach((field) => {
        const next = values[field];
        if (next === undefined || sameField(step[field], next)) return;
        this.recordStepField(stepId, field, next as string | number);
        touched += 1;
      });
      if (touched > 0) {
        this.notify(
          this.online ? `已记录 ${touched} 个字段改动到同步批次（基线 V${this.activeBatch?.baseRevision}）` : `断网环境：已记录 ${touched} 个字段改动，联网后同步`,
          this.online ? 'info' : 'warning'
        );
      }
    },

    addComment(content: string, stepId?: string, author?: string, role = '方案') {
      if (!content.trim()) return;
      const targetStepId = stepId ?? this.selectedStepId;
      const targetAuthor = author ?? this.currentUser;
      const batch = this.ensureBatch();
      const localCommentId = makeId('C-LOCAL');
      const createdAt = nowIso();
      const changeId = makeId('CHG');
      batch.changes.push({
        id: changeId,
        type: 'commentAdd',
        stepId: targetStepId,
        content: content.trim(),
        author: targetAuthor,
        role,
        localCommentId,
        createdAt
      });
      batch.updatedAt = createdAt;
      // 本地草稿立即可见
      this.comments.unshift({
        id: localCommentId,
        author: targetAuthor,
        role,
        content: content.trim(),
        status: 'open',
        stepId: targetStepId,
        createdAt,
        clientChangeId: changeId
      });
      this.persistBatches();
      this.persistDraft();
      this.notify(this.online ? '意见已进入同步批次' : '断网环境：意见已暂存到离线批次', this.online ? 'info' : 'warning');
    },

    resolveComment(id: string) {
      const comment = this.comments.find((item) => item.id === id);
      if (!comment || comment.status !== 'open') return;
      comment.status = 'resolved';
      const batch = this.ensureBatch();
      // 本批离线新增、尚未同步的意见：不重复产生关闭变更（新增即带 open 状态）
      const pendingAdd = batch.changes.some(
        (change) => change.type === 'commentAdd' && (change.localCommentId === id || change.id === comment.clientChangeId)
      );
      if (!pendingAdd) {
        batch.changes.push({ id: makeId('CHG'), type: 'commentResolve', commentId: id, author: this.currentUser, at: nowIso() });
      }
      batch.updatedAt = nowIso();
      this.persistBatches();
      this.persistDraft();
    },

    // ================= 同步编排 =================
    async refreshMeta(): Promise<ServerMeta> {
      const meta = await planServer.getMeta();
      this.serverMeta = meta;
      this.persistDraft();
      return meta;
    },

    /**
     * 提交活动批次到服务端做字段级合并。
     * 同步失败保留未完成批次并安排重试；已成功字段通过幂等 id 不重复入库。
     */
    async syncBatch(batchId?: string) {
      const batch = batchId ? this.batches.find((item) => item.id === batchId) : this.activeBatch;
      if (!batch || this.syncing) return;
      if (!this.online) {
        this.notify('当前处于断网模式，批次已在本机保留，联网后自动重试', 'warning');
        return;
      }
      this.syncing = true;
      batch.status = 'syncing';
      batch.attempts += 1;
      this.clearRetry();
      try {
        const meta = await this.refreshMeta();
        const result = await planServer.commitBatch(batch);
        batch.appliedChangeIds = Array.from(new Set([...batch.appliedChangeIds, ...result.appliedChangeIds]));
        batch.conflicts = mergeConflictState(batch.conflicts, result.conflicts);
        batch.blocked = result.blocked;        batch.serverRevision = meta.revision;
        this.serverPlan = result.plan;
        this.serverMeta = {
          revision: result.plan.revision,
          status: result.plan.status,
          lockedFields: meta.lockedFields,
          signOff: result.plan.signOff
        };

        if (batch.conflicts.some((item) => !item.resolution)) {
          batch.status = 'conflicts';
          this.notify(`同步命中 ${batch.conflicts.filter((c) => !c.resolution).length} 个同字段冲突，请逐项选择保留哪一方`, 'warning');
        } else {
          await this.finalizeBatch(batch.id);
          return;
        }
      } catch (error) {
        batch.status = 'failed';
        batch.lastError = error instanceof Error ? error.message : String(error);
        this.notify(`同步失败：${batch.lastError}。批次保留，${RETRY_DELAY_MS / 1000} 秒后自动重试`, 'negative');
        this.scheduleRetry();
      } finally {
        this.syncing = false;
        this.persistBatches();
        this.persistDraft();
      }
    },

    /** 人工选择冲突字段采用哪一方。 */
    resolveConflict(changeId: string, resolution: 'local' | 'server') {
      const batch = this.activeBatch;
      const conflict = batch?.conflicts.find((item) => item.changeId === changeId);
      if (!conflict || !batch) return;
      conflict.resolution = resolution;
      conflict.resolvedAt = nowIso();
      // 选择服务端值时，直接从工作副本撤掉该字段的现场值
      if (resolution === 'server') {
        const step = this.steps.find((item) => item.id === conflict.stepId);
        if (step) (step[conflict.field] as string | number) = conflict.serverValue;
        // 该改动视为已按服务端值入库
        batch.appliedChangeIds = Array.from(new Set([...batch.appliedChangeIds, changeId]));
      }
      this.persistBatches();
      this.persistDraft();
      if (!batch.conflicts.some((item) => !item.resolution)) {
        this.notify('冲突已全部处理，可以完成合并发布新版本', 'positive');
      }
    },

    /**
     * 完成合并：全部冲突有选择后落地版本、重算净空/荷载率风险；
     * 新风险使原会签结论失效并重开相关意见，随后整体对齐到新版本。
     */
    async finalizeBatch(batchId?: string) {
      const batch = batchId ? this.batches.find((item) => item.id === batchId) : this.activeBatch;
      if (!batch) return;
      if (batch.conflicts.some((item) => !item.resolution)) {
        this.notify('仍有同字段冲突未选择，暂不能完成合并', 'warning');
        return;
      }
      if (!this.online) {
        this.notify('断网中无法完成合并，已保留处理结果，联网后继续', 'warning');
        return;
      }
      this.syncing = true;
      this.clearRetry();
      try {
        const result = await planServer.finalizeBatch(batch);
        batch.finalRevision = result.plan.revision;
        batch.committedAt = nowIso();
        batch.riskReport = result.riskReport;
        batch.status = 'committed';
        await this.adoptPlan(result.plan, `批次 ${batch.id.slice(-6).toUpperCase()} 合并完成`);
        if (result.riskReport.newFindings.length > 0) {
          const reopened = result.riskReport.reopenedCommentIds.length;
          const invalid = result.riskReport.signOffInvalidated ? '，原会签结论已失效' : '';
          this.notify(`合并引入新风险：${result.riskReport.newFindings.length} 项，重新打开 ${reopened} 条相关意见${invalid}`, 'negative');
        } else {
          this.notify(`已成功字段 ${batch.appliedChangeIds.length} 项全部对齐到 V${result.plan.revision}，无新增风险`, 'positive');
        }
      } catch (error) {
        batch.status = batch.conflicts.some((item) => !item.resolution) ? 'conflicts' : 'failed';
        batch.lastError = error instanceof Error ? error.message : String(error);
        this.notify(`完成合并失败：${batch.lastError}。已成功字段不会重复入库，可继续重试`, 'negative');
        this.scheduleRetry();
      } finally {
        this.syncing = false;
        this.persistBatches();
      }
    },

    /** 把服务端版本整体对齐到本地：步骤、意见、会签、快照指向同一版本。 */
    async adoptPlan(plan: PlanStateDTO, reason: string) {
      this.steps = clone(plan.steps);
      this.comments = clone(plan.comments);
      this.reviewers = clone(plan.reviewers);
      this.signOff = clone(plan.signOff);
      this.workingRevision = plan.revision;
      this.serverPlan = clone(plan);
      const lockedFields = this.serverMeta.lockedFields;
      this.serverMeta = {
        revision: plan.revision,
        status: plan.status,
        lockedFields,
        signOff: clone(plan.signOff)
      };
      writePlanSnapshot(plan);
      this.lastSnapshot = readSnapshotMeta();
      this.notify(`${reason}，本地草稿已对齐到 V${plan.revision}`, 'positive');
      this.persistDraft();
    },

    async pullServer() {
      if (!this.online) {
        this.notify('断网中无法拉取，本机离线批次仍可继续编辑', 'warning');
        return;
      }
      const plan = await planServer.pull();
      await this.refreshMeta();
      await this.adoptPlan(plan, '已拉取当前锁定版本与会签意见');
    },

    autoSync() {
      if (!this.online || this.syncing) return;
      const batch = this.activeBatch;
      if (!batch) return;
      if (batch.status === 'conflicts') {
        if (!batch.conflicts.some((item) => !item.resolution)) void this.finalizeBatch(batch.id);
        return;
      }
      void this.syncBatch(batch.id);
    },

    scheduleRetry() {
      this.clearRetry();
      this.retryDueAt = new Date(Date.now() + RETRY_DELAY_MS).toISOString();
      this.retryTimer = window.setTimeout(() => {
        if (this.online) this.autoSync();
        else this.scheduleRetry();
      }, RETRY_DELAY_MS);
    },

    clearRetry() {
      if (this.retryTimer) window.clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      this.retryDueAt = '';
    },

    /** 放弃批次：用批次基线重放本地草稿，回到改动前（未提交内容仍可在批次记录里找回）。 */
    abandonBatch(batchId?: string) {
      const batch = batchId ? this.batches.find((item) => item.id === batchId) : this.activeBatch;
      if (!batch) return;
      this.steps = clone(batch.baselineSteps);
      this.comments = clone(batch.baselineComments);
      this.workingRevision = batch.baseRevision;
      batch.status = 'abandoned';
      this.clearRetry();
      this.notify('已按批次基线恢复草稿，待同步内容仍保留在批次记录中可查看', 'warning');
      this.persistBatches();
      this.persistDraft();
    },

    /** 找回历史批次：把其中的现场改动重新载入新的待同步批次。 */
    recoverBatch(batchId: string) {
      const source = this.batches.find((item) => item.id === batchId);
      if (!source) return;
      if (this.activeBatch) {
        this.notify('请先处理或放弃当前未完成批次，再找回历史草稿', 'warning');
        return;
      }
      const recovered: SyncBatch = {
        ...clone(source),
        id: makeId('BATCH'),
        status: 'open',
        conflicts: [],
        blocked: [],
        appliedChangeIds: [],
        attempts: 0,
        serverRevision: undefined,
        finalRevision: undefined,
        committedAt: undefined,
        riskReport: undefined,
        lastError: undefined,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        baselineSteps: clone(this.steps),
        baselineComments: clone(this.comments),
        baseRevision: this.workingRevision
      };
      // 重放字段值到工作副本
      for (const change of recovered.changes) {
        if (change.type === 'stepField') {
          const step = this.steps.find((item) => item.id === change.stepId);
          if (step) (step[change.field] as string | number) = change.value;
        } else if (change.type === 'commentAdd') {
          if (!this.comments.some((c) => c.clientChangeId === change.id)) {
            this.comments.unshift({
              id: change.localCommentId,
              author: change.author,
              role: change.role,
              content: change.content,
              status: 'open',
              stepId: change.stepId,
              createdAt: change.createdAt,
              clientChangeId: change.id
            });
          }
        }
      }
      this.batches.unshift(recovered);
      this.draftRecovered = true;
      this.notify(`已找回批次 ${source.id.slice(-6).toUpperCase()} 的待同步内容，可继续编辑后同步`, 'positive');
      this.persistBatches();
      this.persistDraft();
    },

    // ================= 发布门禁 =================
    async lockPlan() {
      if (!this.online) {
        this.notify('断网环境不能锁定发布，离线批次同步完成后再操作', 'warning');
        return false;
      }
      if (this.activeBatch) {
        this.notify('还有未完成的同步批次，请先完成合并再锁定发布', 'warning');
        return false;
      }
      if (this.conflicts.length > 0 || this.openComments.length > 0) {
        this.notify('冲突未清零或仍有打开的会签意见，未达到发布门禁', 'negative');
        return false;
      }
      const plan = await planServer.lockPlan();
      await this.adoptPlan(plan, '方案已锁定发布');
      return true;
    },

    // ================= 演练（模拟服务端事件） =================
    async devCoworkerEdit(stepId: string, field: StepField, value: string | number, author?: string) {
      const plan = await planServer.devCoworkerEdit(stepId, field, value, author);
      this.serverPlan = plan;
      await this.refreshMeta();
      this.notify(`演练：服务端收到对 ${stepId}.${field} 的会签修订，当前锁定版本为 V${plan.revision}`, 'info');
    },

    async devLockField(stepId: string, field: StepField) {
      const meta = await planServer.devLockField(stepId, field);
      this.serverMeta = meta;
      this.notify(`演练：${stepId} 的「${field}」已被会签锁定，同步时该字段改动将被拒绝`, 'warning');
      this.persistDraft();
    },

    async devUnlockField(stepId: string, field: StepField) {
      const meta = await planServer.devUnlockField(stepId, field);
      this.serverMeta = meta;
      this.persistDraft();
    },

    async devCompleteSignOff() {
      const plan = await planServer.devCompleteSignOff();
      this.serverPlan = plan;
      await this.refreshMeta();
      this.notify('演练：四角色已在当前版本完成会签，结论生效', 'positive');
    },

    async devLockPlan() {
      const plan = await planServer.lockPlan();
      this.serverPlan = plan;
      await this.refreshMeta();
      this.notify('演练：服务端已锁定发布方案，后续批次的锁定字段改动将被拒绝', 'warning');
    },

    async devFailNext(commits: number, finalizes = 0) {
      await planServer.devFailNext(commits, finalizes);
      this.notify(`演练：服务端将在接下来 ${commits} 次提交 / ${finalizes} 次完成时返回同步失败`, 'warning');
    },

    async devResetAll() {
      this.clearRetry();
      const plan = await planServer.devReset();
      this.batches = [];
      this.steps = clone(plan.steps);
      this.comments = clone(plan.comments);
      this.reviewers = clone(plan.reviewers);
      this.signOff = clone(plan.signOff);
      this.workingRevision = plan.revision;
      this.serverPlan = clone(plan);
      this.serverMeta = { revision: plan.revision, status: plan.status, lockedFields: [], signOff: clone(plan.signOff) };
      this.selectedStepId = 'S-02';
      writePlanSnapshot(plan);
      this.lastSnapshot = readSnapshotMeta();
      this.draftRecovered = false;
      this.persistBatches();
      this.persistDraft();
      this.notify('演练环境已复位到 V4 会签中基线', 'positive');
    },

    // ================= 持久化 =================
    persistBatches() {
      localStorage.setItem(BATCH_KEY, JSON.stringify(this.batches));
    },
    persistDraft() {
      const payload: PersistedDraft = {
        steps: this.steps,
        comments: this.comments,
        reviewers: this.reviewers,
        signOff: this.signOff,
        workingRevision: this.workingRevision,
        serverMeta: this.serverMeta,
        selectedStepId: this.selectedStepId,
        viewBookmarks: this.viewBookmarks,
        activeBookmark: this.activeBookmark,
        currentUser: this.currentUser,
        deviceName: this.deviceName
      };
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...payload, draftSavedAt: nowIso() }));
    },

    startup() {
      writePlanSnapshot({
        id: this.planId,
        name: this.planName,
        revision: this.workingRevision,
        status: this.serverMeta.status,
        steps: this.steps,
        comments: this.comments,
        reviewers: this.reviewers,
        signOff: this.signOff
      });
      this.lastSnapshot = readSnapshotMeta();
      const recovered = this.pendingBatches.length;
      if (recovered > 0) {
        this.draftRecovered = true;
        this.notify(`本机找回 ${recovered} 个未完成离线批次，内容未丢失，联网后继续同步`, 'warning');
      }
      if (this.online) void this.refreshMeta().catch(() => undefined);
    }
  }
});

/**
 * 合并冲突清单：
 * - 服务端仍返回的冲突，保留上一轮已做的人工选择
 * - 服务端已不再回显（已按选择落地）的已解决冲突，本地保留一行用于展示结果
 */
function mergeConflictState(previous: FieldConflict[], incoming: FieldConflict[]): FieldConflict[] {
  const merged = incoming.map((conflict) => {
    const prior = previous.find((item) => item.changeId === conflict.changeId);
    return prior?.resolution ? { ...conflict, resolution: prior.resolution, resolvedAt: prior.resolvedAt } : conflict;
  });
  const incomingIds = new Set(incoming.map((item) => item.changeId));
  for (const prior of previous) {
    if (prior.resolution && !incomingIds.has(prior.changeId)) merged.push(prior);
  }
  return merged;
}
