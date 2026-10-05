import { defineStore } from 'pinia';
import {
  readSnapshot,
  writeSnapshot,
  initialSteps,
  initialComments,
  initialSignoffs,
  TRACKED_STEP_FIELDS,
  RISK_FIELDS,
  isRisky,
  planId,
  type SnapshotStep,
  type SnapshotComment,
  type SnapshotSignoff,
  type PlanSnapshot
} from './graphql';

export type StepStatus = 'pending' | 'passed' | 'blocked';
export type Comment = SnapshotComment;
export type LiftStep = SnapshotStep;
export type SignoffState = 'accepted' | 'pending' | 'reserved';
export type Signoff = SnapshotSignoff;

/** 单个字段的离线改动项：记录基线版本、修改人与字段值。 */
export type FieldChange = {
  id: string;
  field: string;
  baseValue: number | string;
  localValue: number | string;
  synced: boolean;
};

export type StepChange = {
  stepId: string;
  fields: FieldChange[];
};

export type BatchStatus = 'pending' | 'syncing' | 'conflict' | 'failed' | 'synced';

export type ChangeBatch = {
  id: string;
  createdAt: string;
  createdBy: string;
  baselineRevision: number;
  status: BatchStatus;
  changes: StepChange[];
  retryCount: number;
  lastError?: string;
  syncedAt?: string;
};

export type FieldConflict = {
  id: string;
  batchId: string;
  stepId: string;
  field: string;
  baseValue: number | string;
  localValue: number | string;
  serverValue: number | string;
  reason: 'both-modified' | 'locked';
  status: 'open' | 'resolved';
  resolution?: 'local' | 'server';
};

type DraftShape = {
  steps?: LiftStep[];
  comments?: Comment[];
  selectedStepId?: string;
  revision?: number;
  locked?: boolean;
  viewBookmarks?: string[];
  activeBookmark?: string;
  batches?: ChangeBatch[];
  fieldConflicts?: FieldConflict[];
  signoffs?: Signoff[];
  forceOffline?: boolean;
  currentUserName?: string;
};

const cacheKey = 'yy58-lift-plan-draft';
const currentUser = '王工';
const currentRole = '方案';

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function loadDraft(): DraftShape {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(cacheKey);
    return raw ? (JSON.parse(raw) as DraftShape) : {};
  } catch {
    return {};
  }
}

const saved = loadDraft();

function onlineNow(): boolean {
  return typeof navigator !== 'undefined' ? navigator.onLine : true;
}

export const useLiftStore = defineStore('lift-plan', {
  state: () => ({
    steps: (saved.steps as LiftStep[]) ?? deepCopy(initialSteps),
    comments: (saved.comments as Comment[]) ?? deepCopy(initialComments),
    selectedStepId: (saved.selectedStepId as string) ?? 'S-02',
    revision: (saved.revision as number) ?? 4,
    locked: (saved.locked as boolean) ?? false,
    viewBookmarks: (saved.viewBookmarks as string[]) ?? ['主吊全景', '东侧障碍', '安装轴线'],
    activeBookmark: (saved.activeBookmark as string) ?? '主吊全景',
    signoffs: (saved.signoffs as Signoff[]) ?? deepCopy(initialSignoffs),
    batches: (saved.batches as ChangeBatch[]) ?? [],
    fieldConflicts: (saved.fieldConflicts as FieldConflict[]) ?? [],
    forceOffline: (saved.forceOffline as boolean) ?? false,
    isOnline: onlineNow(),
    currentBatchId:
      (saved.batches as ChangeBatch[] | undefined)?.find((b) => b.status === 'pending' || b.status === 'failed')?.id ??
      null,
    syncing: false,
    lastSyncAt: null as string | null,
    invalidated: false,
    invalidatedAt: null as string | null
  }),
  getters: {
    selectedStep(state): LiftStep {
      return state.steps.find((step) => step.id === state.selectedStepId) ?? state.steps[0];
    },
    /** 规则冲突（由当前版本步骤派生，与版本快照指向同一 revision）。 */
    conflicts(state) {
      return state.steps.flatMap((step) => {
        const issues: string[] = [];
        if (step.loadRate > 90) issues.push(`荷载率 ${step.loadRate}% 超过 90% 阈值`);
        if (step.clearance < 1.5) issues.push(`净空 ${step.clearance}m 小于 1.5m`);
        if (step.wind > 8) issues.push(`风速 ${step.wind}m/s 超过暂停值`);
        if (step.radius > step.boom * 0.62) issues.push('工作半径接近额定幅度');
        return issues.map((message, index) => ({
          id: `${step.id}-${index}`,
          stepId: step.id,
          title: step.title,
          message,
          severity: (step.status === 'blocked' ? 'high' : 'medium') as 'high' | 'medium'
        }));
      });
    },
    openComments(state) {
      return state.comments.filter((comment) => comment.status === 'open');
    },
    readiness(state): number {
      const passedChecks = state.steps.filter((step) => step.status === 'passed').length;
      const commentPenalty = state.comments.filter((item) => item.status === 'open').length * 12;
      const signoffPenalty = state.signoffs.filter((s) => s.state !== 'accepted').length * 6;
      return Math.max(0, Math.round((passedChecks / state.steps.length) * 100 - commentPenalty - signoffPenalty));
    },
    effectiveOnline(state): boolean {
      return !state.forceOffline && state.isOnline;
    },
    pendingBatches(state): ChangeBatch[] {
      return state.batches.filter((b) => b.status === 'pending' || b.status === 'failed' || b.status === 'conflict');
    },
    activeBatch(state): ChangeBatch | null {
      return state.batches.find((b) => b.id === state.currentBatchId) ?? null;
    },
    openFieldConflicts(state): FieldConflict[] {
      return state.fieldConflicts.filter((c) => c.status === 'open');
    },
    hasPendingSync(state): boolean {
      return state.batches.some((b) => b.status === 'pending' || b.status === 'failed');
    }
  },
  actions: {
    // ─────────────────────────────────────────────────────────────
    // 基础编辑
    // ─────────────────────────────────────────────────────────────
    selectStep(id: string) {
      this.selectedStepId = id;
      this.persist();
    },
    updateStep(patch: Partial<LiftStep> = {}) {
      const index = this.steps.findIndex((step) => step.id === this.selectedStepId);
      if (index >= 0 && Object.keys(patch).length > 0) {
        this.steps[index] = { ...this.steps[index], ...patch };
      }
      if (!this.syncing) this.recordChanges();
      this.persist();
    },
    setStatus(status: StepStatus) {
      this.updateStep({ status });
    },
    addComment(content: string, author = currentUser, role = currentRole) {
      if (!content.trim()) return;
      this.comments.unshift({
        id: `C-${Date.now()}`,
        author,
        role,
        content,
        status: 'open',
        stepId: this.selectedStepId
      });
      this.persist();
    },
    resolveComment(id: string) {
      const item = this.comments.find((comment) => comment.id === id);
      if (item) item.status = 'resolved';
      this.persist();
    },
    setSignoffState(id: string, state: Signoff['state']) {
      const item = this.signoffs.find((s) => s.id === id);
      if (item) item.state = state;
      this.persist();
    },

    // ─────────────────────────────────────────────────────────────
    // 离线批次：把离线改动按批次记录，每项带基线版本、修改人、字段值
    // ─────────────────────────────────────────────────────────────
    ensureBatch(): ChangeBatch {
      if (this.currentBatchId) {
        const existing = this.batches.find((b) => b.id === this.currentBatchId);
        if (existing) return existing;
      }
      const snapshot = this.readServerSnapshot();
      const batch: ChangeBatch = {
        id: `B-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        createdAt: new Date().toISOString(),
        createdBy: currentUser,
        baselineRevision: snapshot.revision,
        status: 'pending',
        changes: [],
        retryCount: 0
      };
      this.batches.push(batch);
      this.currentBatchId = batch.id;
      return batch;
    },

    /** 对比本地步骤与服务端快照，把净改动写入当前批次。 */
    recordChanges() {
      const snapshot = this.readServerSnapshot();
      const batch = this.ensureBatch();
      for (const localStep of this.steps) {
        const serverStep = snapshot.steps.find((s) => s.id === localStep.id);
        if (!serverStep) continue;
        let stepChange = batch.changes.find((c) => c.stepId === localStep.id);
        for (const field of TRACKED_STEP_FIELDS) {
          const baseValue = serverStep[field] as number | string;
          const localValue = localStep[field] as number | string;
          if (Object.is(baseValue, localValue)) {
            // 字段已回到基线：移除该字段改动项
            if (stepChange) {
              stepChange.fields = stepChange.fields.filter((f) => f.field !== field);
            }
            continue;
          }
          if (!stepChange) {
            stepChange = { stepId: localStep.id, fields: [] };
            batch.changes.push(stepChange);
          }
          const existing = stepChange.fields.find((f) => f.field === field);
          if (existing) {
            existing.localValue = localValue;
            existing.synced = false;
          } else {
            stepChange.fields.push({
              id: `${batch.id}:${localStep.id}:${field}`,
              field,
              baseValue,
              localValue,
              synced: false
            });
          }
        }
        if (stepChange && stepChange.fields.length === 0) {
          batch.changes = batch.changes.filter((c) => c.stepId !== localStep.id);
        }
      }
      if (batch.changes.length === 0 && batch.status === 'pending') {
        // 空批次不留存
        this.batches = this.batches.filter((b) => b.id !== batch.id);
        this.currentBatchId = null;
      }
      this.persist();
    },

    readServerSnapshot(): PlanSnapshot {
      try {
        return readSnapshot();
      } catch {
        return {
          __typename: 'LiftPlan',
          id: planId,
          name: '东塔转换桁架吊装',
          revision: this.revision,
          status: this.locked ? 'LOCKED' : 'REVIEW',
          steps: deepCopy(this.steps),
          comments: deepCopy(this.comments),
          signoffs: deepCopy(this.signoffs)
        };
      }
    },

    // ─────────────────────────────────────────────────────────────
    // 联网同步：逐字段合并，冲突让人选择，锁定内容不可覆盖
    // ─────────────────────────────────────────────────────────────
    async syncAll() {
      if (this.syncing) return;
      const targets = this.batches.filter((b) => b.status === 'pending' || b.status === 'failed');
      if (targets.length === 0) return;
      this.syncing = true;
      for (const batch of targets) {
        await this.syncBatch(batch).catch(() => {
          /* 单批失败保留批次，继续重试其它批次 */
        });
      }
      this.syncing = false;
      this.lastSyncAt = new Date().toISOString();
      this.persist();
    },

    async syncBatch(batch: ChangeBatch) {
      if (batch.status === 'synced') return;
      batch.status = 'syncing';
      batch.lastError = undefined;
      this.persist();

      try {
        // 模拟联网失败：保留未完成批次，稍后重试
        if (this.forceOffline && !this.isOnline) {
          throw new Error('NETWORK_OFFLINE');
        }
        const snapshot = this.readServerSnapshot();
        const serverSteps = deepCopy(snapshot.steps);
        const conflicts: FieldConflict[] = [];
        const appliedFields: FieldChange[] = [];
        let touchedRisk = false;

        for (const stepChange of batch.changes) {
          const serverStep = serverSteps.find((s) => s.id === stepChange.stepId);
          if (!serverStep) continue;
          for (const fieldChange of stepChange.fields) {
            if (fieldChange.synced) continue; // 已成功字段不重复入库
            const serverValue = serverStep[fieldChange.field as keyof SnapshotStep] as number | string;
            const { baseValue, localValue } = fieldChange;

            // 锁定内容不能被覆盖
            if (this.locked && localValue !== serverValue) {
              conflicts.push(this.buildConflict(batch, stepChange.stepId, fieldChange, serverValue, 'locked'));
              continue;
            }

            if (Object.is(serverValue, baseValue)) {
              // 服务端自基线未变：采用本地值
              (serverStep as Record<string, unknown>)[fieldChange.field] = localValue;
              appliedFields.push(fieldChange);
              if (RISK_FIELDS.includes(fieldChange.field as keyof SnapshotStep)) touchedRisk = true;
            } else if (Object.is(localValue, baseValue)) {
              // 本地实际未改：保留服务端
              appliedFields.push(fieldChange);
            } else if (Object.is(localValue, serverValue)) {
              // 双方改成一致：无需冲突
              appliedFields.push(fieldChange);
            } else {
              // 双方改过同一字段：列出冲突让人选择
              conflicts.push(this.buildConflict(batch, stepChange.stepId, fieldChange, serverValue, 'both-modified'));
            }
          }
        }

        if (conflicts.length > 0) {
          batch.status = 'conflict';
          this.fieldConflicts.push(...conflicts);
          this.persist();
          return;
        }

        // 全部字段合并完成：写入新版本快照
        const merged = this.finalizeSnapshot(snapshot, serverSteps);
        writeSnapshot(merged);
        // 快照写入成功后才标记字段已同步，失败重试时不会重复入库
        for (const field of appliedFields) field.synced = true;
        this.applyMergedState(merged);
        batch.status = 'synced';
        batch.syncedAt = new Date().toISOString();
        batch.retryCount = 0;
        if (this.currentBatchId === batch.id) this.currentBatchId = null;

        // 净空 / 荷载率变化产生新风险：原会签结论失效，相关意见重新打开
        if (touchedRisk) this.invalidateForRisk(serverSteps);
        this.persist();
      } catch (error) {
        batch.status = 'failed';
        batch.retryCount += 1;
        batch.lastError = error instanceof Error ? error.message : 'SYNC_FAILED';
        this.persist();
        this.scheduleRetry(batch);
        throw error;
      }
    },

    buildConflict(
      batch: ChangeBatch,
      stepId: string,
      fieldChange: FieldChange,
      serverValue: number | string,
      reason: FieldConflict['reason']
    ): FieldConflict {
      return {
        id: `FC-${batch.id}:${stepId}:${fieldChange.field}`,
        batchId: batch.id,
        stepId,
        field: fieldChange.field,
        baseValue: fieldChange.baseValue,
        localValue: fieldChange.localValue,
        serverValue,
        reason,
        status: 'open'
      };
    },

    /** 冲突解决后记录选择；全部冲突解决后一次性合并入库。锁定内容不可覆盖。 */
    resolveFieldConflict(conflictId: string, resolution: 'local' | 'server') {
      const conflict = this.fieldConflicts.find((c) => c.id === conflictId);
      if (!conflict || conflict.status !== 'open') return;
      // 锁定内容不能被覆盖：强制采用远端（当前锁定版本）
      if (conflict.reason === 'locked') resolution = 'server';
      conflict.status = 'resolved';
      conflict.resolution = resolution;

      const batch = this.batches.find((b) => b.id === conflict.batchId);
      const stillOpen = this.fieldConflicts.some((c) => c.batchId === conflict.batchId && c.status === 'open');
      if (!stillOpen && batch) {
        const snapshot = this.readServerSnapshot();
        const serverSteps = deepCopy(snapshot.steps);
        const batchConflicts = this.fieldConflicts.filter((c) => c.batchId === batch.id);
        const conflictKeys = new Set(batchConflicts.map((c) => `${c.stepId}:${c.field}`));

        // 应用所有已解决冲突的选择
        for (const c of batchConflicts) {
          const serverStep = serverSteps.find((s) => s.id === c.stepId);
          if (serverStep) {
            const chosen = c.resolution === 'local' ? c.localValue : c.serverValue;
            (serverStep as Record<string, unknown>)[c.field] = chosen;
          }
        }
        // 应用非冲突字段（初次同步已校验：服务端未变或双方一致）
        for (const stepChange of batch.changes) {
          const serverStep = serverSteps.find((s) => s.id === stepChange.stepId);
          if (!serverStep) continue;
          for (const fieldChange of stepChange.fields) {
            if (conflictKeys.has(`${stepChange.stepId}:${fieldChange.field}`)) continue;
            (serverStep as Record<string, unknown>)[fieldChange.field] = fieldChange.localValue;
            fieldChange.synced = true;
          }
        }
        for (const c of batchConflicts) {
          const fc = batch.changes
            .find((sc) => sc.stepId === c.stepId)
            ?.fields.find((f) => f.field === c.field);
          if (fc) fc.synced = true;
        }

        const touchedRisk =
          batchConflicts.some((c) => RISK_FIELDS.includes(c.field as keyof SnapshotStep)) ||
          batch.changes.some((sc) => sc.fields.some((f) => RISK_FIELDS.includes(f.field as keyof SnapshotStep)));
        if (touchedRisk) this.invalidateForRisk(serverSteps);

        // 一次性写入新版本快照
        const merged = this.finalizeSnapshot(snapshot, serverSteps);
        writeSnapshot(merged);
        this.applyMergedState(merged);
        batch.status = 'synced';
        batch.syncedAt = new Date().toISOString();
        if (this.currentBatchId === batch.id) this.currentBatchId = null;
      }
      this.persist();
    },

    finalizeSnapshot(snapshot: PlanSnapshot, steps: SnapshotStep[]): PlanSnapshot {
      return {
        ...snapshot,
        revision: snapshot.revision + 1,
        status: this.locked ? 'LOCKED' : 'REVIEW',
        steps: steps.map((s) => ({ ...s })),
        comments: this.comments.map((c) => ({ ...c })),
        signoffs: this.signoffs.map((s) => ({ ...s }))
      };
    },

    applyMergedState(snapshot: PlanSnapshot) {
      this.steps = snapshot.steps.map((s) => ({ ...s }));
      this.comments = snapshot.comments.map((c) => ({ ...c }));
      this.signoffs = snapshot.signoffs.map((s) => ({ ...s }));
      this.revision = snapshot.revision;
      this.locked = snapshot.status === 'LOCKED';
    },

    /** 净空 / 荷载率越限：会签结论失效，相关意见重新打开。 */
    invalidateForRisk(steps: SnapshotStep[]) {
      const riskyStepIds = steps.filter((s) => isRisky(s)).map((s) => s.id);
      if (riskyStepIds.length === 0) return;
      for (const comment of this.comments) {
        if (riskyStepIds.includes(comment.stepId) && comment.status === 'resolved') {
          comment.status = 'open';
        }
      }
      // 会签结论失效：所有角色回到待确认
      for (const signoff of this.signoffs) signoff.state = 'pending';
      this.invalidated = true;
      this.invalidatedAt = new Date().toISOString();
      this.persist();
    },

    scheduleRetry(batch: ChangeBatch) {
      if (batch.retryCount >= 3) return; // 超过自动重试次数，保留批次等待手动重试
      window.setTimeout(() => {
        if (batch.status === 'failed') void this.syncBatch(batch).catch(() => undefined);
      }, 4000);
    },

    retryBatch(batchId: string) {
      const batch = this.batches.find((b) => b.id === batchId);
      if (!batch) return;
      batch.retryCount = 0;
      batch.status = 'pending';
      batch.lastError = undefined;
      void this.syncBatch(batch).catch(() => undefined);
    },

    // ─────────────────────────────────────────────────────────────
    // 网络状态与演示操作
    // ─────────────────────────────────────────────────────────────
    setOnline(value: boolean) {
      this.isOnline = value;
      this.persist();
      if (value && !this.forceOffline) void this.syncAll();
    },
    toggleForceOffline() {
      this.forceOffline = !this.forceOffline;
      this.persist();
      if (!this.forceOffline && this.isOnline) void this.syncAll();
    },

    /** 模拟远端（另一工程师）在离线期间同步了变更，用于演示冲突。 */
    simulateRemoteChange() {
      const snapshot = this.readServerSnapshot();
      const steps = deepCopy(snapshot.steps);
      const s02 = steps.find((s) => s.id === 'S-02');
      if (s02) s02.clearance = 1.0; // 远端把净空改到越限
      const s05 = steps.find((s) => s.id === 'S-05');
      if (s05) s05.loadRate = 95; // 远端把荷载率改到越限
      const comments = deepCopy(snapshot.comments);
      writeSnapshot({ ...snapshot, revision: snapshot.revision + 1, steps, comments });
      // 无未完成批次时同步刷新本地，避免界面停留在旧值；有批次时保留本地改动以演示冲突
      const hasPending = this.batches.some((b) => b.status === 'pending' || b.status === 'failed' || b.status === 'conflict');
      if (!hasPending) {
        this.steps = steps.map((s) => ({ ...s }));
        this.comments = comments.map((c) => ({ ...c }));
        this.revision = snapshot.revision + 1;
      }
      this.persist();
    },

    lockPlan() {
      if (this.conflicts.length === 0 && this.openComments.length === 0) {
        this.locked = true;
        this.revision += 1;
        const snapshot = this.readServerSnapshot();
        writeSnapshot({
          ...snapshot,
          revision: this.revision,
          status: 'LOCKED',
          steps: deepCopy(this.steps),
          comments: deepCopy(this.comments),
          signoffs: deepCopy(this.signoffs)
        });
      }
      this.persist();
    },

    setBookmark(name: string) {
      this.activeBookmark = name;
      if (!this.viewBookmarks.includes(name)) this.viewBookmarks.push(name);
      this.persist();
    },

    persist() {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(
        cacheKey,
        JSON.stringify({ ...this.$state, draftSavedAt: new Date().toISOString() })
      );
    }
  }
});

export { currentUser };
