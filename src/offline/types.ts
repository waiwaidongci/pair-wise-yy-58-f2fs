// 离线批次变更领域模型：每条改动都携带基线版本、修改人与字段值，
// 联网后由合并引擎逐字段做「基线 / 现场值 / 服务端当前值」三方比对。

export type StepStatus = 'pending' | 'passed' | 'blocked';

export interface StepParams {
  id: string;
  title: string;
  time: string;
  loadRate: number;
  clearance: number;
  wind: number;
  radius: number;
  boom: number;
  status: StepStatus;
  note: string;
}

export type StepField = 'time' | 'loadRate' | 'clearance' | 'wind' | 'radius' | 'boom' | 'status' | 'note';

export const STEP_FIELDS: StepField[] = ['time', 'loadRate', 'clearance', 'wind', 'radius', 'boom', 'status', 'note'];

export const FIELD_LABELS: Record<StepField, string> = {
  time: '开始时间',
  loadRate: '荷载率',
  clearance: '最小净空',
  wind: '风速',
  radius: '作业半径',
  boom: '臂长',
  status: '步骤结论',
  note: '现场控制说明'
};

export const NUMERIC_FIELDS: StepField[] = ['loadRate', 'clearance', 'wind', 'radius', 'boom'];

/** 合并后需要重新评估安全风险的字段：净空、荷载率 */
export type RiskField = 'loadRate' | 'clearance';

export interface RiskFinding {
  stepId: string;
  field: RiskField;
  message: string;
}

export interface RuleConflict {
  id: string;
  stepId: string;
  title: string;
  message: string;
  severity: 'high' | 'medium';
}

export interface CommentRecord {
  id: string;
  author: string;
  role: string;
  content: string;
  status: 'open' | 'resolved';
  stepId: string;
  createdAt?: string;
  /** 离线新增意见在客户端生成的变更 id，服务端据此幂等入库 */
  clientChangeId?: string;
  /** 合并后新风险导致意见被重新打开的原因 */
  reopenedAt?: string;
  reopenedReason?: string;
}

export interface Reviewer {
  id: string;
  name: string;
  team: string;
  scope: string;
  state: 'accepted' | 'pending' | 'reserved';
  signedAt?: string;
}

export interface SignOffState {
  valid: boolean;
  revision: number;
  decidedAt?: string;
  invalidatedAt?: string;
  reason?: string;
}

// ---------- 批次内的单项改动 ----------

export interface StepFieldChange {
  id: string;
  type: 'stepField';
  /** `${stepId}.${field}`，同批内同一字段反复修改只保留一条，基线值不动 */
  changeKey: string;
  stepId: string;
  field: StepField;
  baselineValue: string | number;
  value: string | number;
  author: string;
  updatedAt: string;
}

export interface CommentAddChange {
  id: string;
  type: 'commentAdd';
  stepId: string;
  content: string;
  author: string;
  role: string;
  localCommentId: string;
  createdAt: string;
}

export interface CommentResolveChange {
  id: string;
  type: 'commentResolve';
  commentId: string;
  author: string;
  at: string;
}

export type BatchChange = StepFieldChange | CommentAddChange | CommentResolveChange;

// ---------- 冲突 / 锁定 / 风险 ----------

export interface FieldConflict {
  changeId: string;
  stepId: string;
  field: StepField;
  baselineValue: string | number;
  localValue: string | number;
  serverValue: string | number;
  resolution?: 'local' | 'server';
  resolvedAt?: string;
}

export interface BlockedChange {
  changeId: string;
  stepId: string;
  field: StepField;
  reason: string;
}

export interface RiskReport {
  /** 合并后净空或荷载率触发的、基线版本上不存在的风险 */
  newFindings: RiskFinding[];
  /** 因此被重新打开的会签意见 */
  reopenedCommentIds: string[];
  /** 原会签结论是否失效 */
  signOffInvalidated: boolean;
}

// ---------- 同步批次 ----------

export type BatchStatus = 'open' | 'syncing' | 'conflicts' | 'failed' | 'committed' | 'abandoned';

export interface SyncBatch {
  id: string;
  deviceName: string;
  author: string;
  /** 基线版本：本批改动是从哪个版本改出来的 */
  baseRevision: number;
  /** 批次基线步骤（改动发生时的值，用于逐字段三方比对与草稿找回） */
  baselineSteps: StepParams[];
  baselineComments: CommentRecord[];
  createdAt: string;
  updatedAt: string;
  status: BatchStatus;
  changes: BatchChange[];
  /** 已成功入库的字段/意见变更，重试时不重复写入 */
  appliedChangeIds: string[];
  conflicts: FieldConflict[];
  blocked: BlockedChange[];
  attempts: number;
  lastError?: string;
  nextRetryAt?: string;
  serverRevision?: number;
  finalRevision?: number;
  committedAt?: string;
  riskReport?: RiskReport;
}

// ---------- 服务端传输对象 ----------

export interface PlanStateDTO {
  id: string;
  name: string;
  revision: number;
  status: 'REVIEW' | 'LOCKED';
  steps: StepParams[];
  comments: CommentRecord[];
  reviewers: Reviewer[];
  signOff: SignOffState;
}

export interface ServerMeta {
  revision: number;
  status: 'REVIEW' | 'LOCKED';
  lockedFields: { stepId: string; field: StepField }[];
  signOff: SignOffState;
}

export interface CommitResultDTO {
  plan: PlanStateDTO;
  appliedChangeIds: string[];
  conflicts: FieldConflict[];
  blocked: BlockedChange[];
}

export interface FinalizeResultDTO {
  plan: PlanStateDTO;
  riskReport: RiskReport;
  revisionChanged: boolean;
  snapshotId: string;
}

export class SyncError extends Error {
  constructor(
    public code: 'NETWORK' | 'HAS_CONFLICTS' | 'NO_BATCH',

    message: string
  ) {
    super(message);
    this.name = 'SyncError';
  }
}
