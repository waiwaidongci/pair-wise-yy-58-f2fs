<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useQuasar } from 'quasar';
import { useLiftStore } from '../store';
import { FIELD_LABELS } from '../offline/types';
import type { BatchChange, FieldConflict, SyncBatch } from '../offline/types';

const store = useLiftStore();
const $q = useQuasar();

const demoStep = ref('S-03');
const demoField = ref<'clearance' | 'loadRate' | 'wind' | 'radius'>('clearance');
const demoValue = ref<string | number>(1.2);

// 驱动自动重试倒计时每秒刷新
const now = ref(Date.now());
let clock = 0;
onMounted(() => {
  clock = window.setInterval(() => {
    now.value = Date.now();
  }, 1000);
});
onBeforeUnmount(() => window.clearInterval(clock));

const activeBatch = computed(() => store.activeBatch);
const meta = computed(() => store.serverMeta);

const stepTitle = (id: string) => store.steps.find((step) => step.id === id)?.title ?? id;

function fieldDisplay(change: BatchChange): { field: string; baseline: string; value: string } | null {
  if (change.type !== 'stepField') return null;
  return { field: FIELD_LABELS[change.field], baseline: String(change.baselineValue), value: String(change.value) };
}

function commentFor(change: BatchChange): { author: string; stepId: string; content: string } | null {
  if (change.type === 'commentAdd') return { author: change.author, stepId: change.stepId, content: change.content };
  if (change.type === 'commentResolve') {
    const comment = store.comments.find((item) => item.id === change.commentId || item.clientChangeId === change.commentId);
    return comment ? { author: change.author, stepId: comment.stepId, content: `关闭意见：${comment.content}` } : null;
  }
  return null;
}

function statusLabel(batch: SyncBatch): { text: string; color: string } {
  switch (batch.status) {
    case 'open':
      return { text: '待同步', color: 'deep-orange' };
    case 'syncing':
      return { text: '同步中', color: 'info' };
    case 'conflicts':
      return { text: '待处理冲突', color: 'warning' };
    case 'failed':
      return { text: '同步失败·重试中', color: 'negative' };
    case 'committed':
      return { text: `已并入 V${batch.finalRevision ?? ''}`, color: 'positive' };
    case 'abandoned':
      return { text: '已放弃（内容可找回）', color: 'grey' };
  }
}

function isApplied(changeId: string): boolean {
  return activeBatch.value?.appliedChangeIds.includes(changeId) ?? false;
}

function blockedReason(changeId: string): string {
  return activeBatch.value?.blocked.find((item) => item.changeId === changeId)?.reason ?? '';
}

function conflictOf(changeId: string): FieldConflict | undefined {
  return activeBatch.value?.conflicts.find((item) => item.changeId === changeId);
}

function changeState(change: BatchChange): { icon: string; label: string; cls: string } {
  if (change.type !== 'stepField') {
    return isApplied(change.id)
      ? { icon: 'check_circle', label: '已幂等入库', cls: 'done' }
      : { icon: 'hourglass_top', label: '待提交', cls: 'wait' };
  }
  const reason = blockedReason(change.id);
  if (reason) return { icon: 'lock', label: '锁定拒绝', cls: 'locked' };
  if (conflictOf(change.id)) return { icon: 'merge_type', label: '字段冲突', cls: 'conflict' };
  if (isApplied(change.id)) return { icon: 'cloud_done', label: '已成功字段', cls: 'done' };
  return { icon: 'hourglass_top', label: '待提交', cls: 'wait' };
}

function fmtTime(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const retryCountdown = computed(() => {
  if (!activeBatch.value?.status || !store.retryDueAt) return 0;
  return Math.max(0, Math.ceil((new Date(store.retryDueAt).getTime() - now.value) / 1000));
});

// ---------- 演练脚本 ----------
async function runCoworkerConflict() {
  await store.devCoworkerEdit(demoStep.value, demoField.value, demoValue.value);
}
async function runSignOffThenRisk() {
  await store.devCompleteSignOff();
  $q.notify({ message: '服务端会签已完成；现在同步本批后，若净空/荷载率越过阈值，结论将失效并重开意见', color: 'positive' });
}
async function runFailures() {
  await store.devFailNext(1, 0);
}
async function runLockField() {
  await store.devLockField(demoStep.value, demoField.value);
}
async function runLockPlan() {
  await store.devLockPlan();
}

function confirmAbandon(batchId: string) {
  $q.dialog({
    title: '放弃该离线批次？',
    message: '本地草稿将恢复到批次基线；待同步内容仍保留在批次记录中，随时可以找回。',
    cancel: true,
    ok: { label: '放弃并恢复基线', color: 'negative' }
  }).onOk(() => store.abandonBatch(batchId));
}
</script>

<template>
  <div class="sync-center">
    <!-- 连接与版本状态 -->
    <section class="content-panel sync-overview">
      <div class="overview-cell">
        <q-icon :name="store.online ? 'wifi' : 'wifi_off'" :color="store.online ? 'positive' : 'warning'" size="28px" />
        <div>
          <strong>{{ store.online ? '已连接办公室网络' : '平板断网中' }}</strong>
          <span>{{ store.online ? '可以执行字段级合并' : '改动只写入本机离线批次，联网后自动继续' }}</span>
        </div>
      </div>
      <div class="overview-cell">
        <q-icon name="tag" color="primary" size="26px" />
        <div>
          <strong>本地 V{{ store.workingRevision }} ↔ 服务端 V{{ meta.revision }}</strong>
          <span>{{ meta.status === 'LOCKED' ? '服务端方案已锁定发布' : '服务端处于会签中' }} · 字段锁定 {{ meta.lockedFields.length }} 项</span>
        </div>
      </div>
      <div class="overview-cell" :class="{ bad: !store.versionCoherence.coherent }">
        <q-icon :name="store.versionCoherence.coherent ? 'verified' : 'error_outline'" :color="store.versionCoherence.coherent ? 'positive' : 'negative'" size="26px" />
        <div>
          <strong>版本一致性{{ store.versionCoherence.coherent ? '通过' : '待对齐' }}</strong>
          <span>{{ store.versionCoherence.detail }}</span>
          <small v-if="store.versionCoherence.snapshotId">快照 {{ store.versionCoherence.snapshotId }}</small>
        </div>
      </div>
    </section>

    <!-- 活动批次 -->
    <section v-if="activeBatch" class="content-panel batch-panel">
      <div class="panel-heading">
        <div>
          <span class="panel-kicker">OFFLINE BATCH · 基线 V{{ activeBatch.baseRevision }}</span>
          <h2>
            批次 {{ activeBatch.id.slice(-8).toUpperCase() }}
            <q-badge :color="statusLabel(activeBatch).color" class="batch-state">{{ statusLabel(activeBatch).text }}</q-badge>
          </h2>
        </div>
        <div class="batch-actions">
          <q-btn
            color="primary"
            no-caps
            icon="sync"
            :label="store.syncing ? '正在合并…' : activeBatch.status === 'conflicts' ? '重新提交合并' : '立即同步'"
            :loading="store.syncing"
            :disable="!store.online"
            @click="store.syncBatch(activeBatch.id)"
          />
          <q-btn
            v-if="activeBatch.status === 'conflicts' && !store.unresolvedConflicts.length"
            color="positive"
            no-caps
            icon="merge"
            label="完成合并并发布新版本"
            :loading="store.syncing"
            @click="store.finalizeBatch(activeBatch.id)"
          />
          <q-btn outline no-caps icon="undo" label="按基线恢复" @click="confirmAbandon(activeBatch.id)" />
        </div>
      </div>

      <div class="batch-meta-row">
        <span><q-icon name="tablet" size="14px" /> {{ activeBatch.deviceName }}</span>
        <span><q-icon name="person" size="14px" /> 修改人 {{ activeBatch.author }}</span>
        <span><q-icon name="history" size="14px" /> 基线版本 V{{ activeBatch.baseRevision }}</span>
        <span><q-icon name="edit" size="14px" /> {{ activeBatch.changes.length }} 项改动 · 已成功 {{ activeBatch.appliedChangeIds.length }} 项</span>
        <span><q-icon name="cloud_download" size="14px" /> 尝试 {{ activeBatch.attempts }} 次</span>
        <span v-if="retryCountdown > 0" class="retry-timer"> {{ retryCountdown }}s 后自动重试</span>
      </div>
      <div v-if="activeBatch.lastError" class="sync-error">
        <q-icon name="error" size="16px" /> {{ activeBatch.lastError }}
        <span>未完成批次与已成功字段均保留，重试不重复入库。</span>
      </div>

      <!-- 改动明细 -->
      <div class="change-table">
        <div class="change-row change-head">
          <span>对象 / 意见</span><span>基线值（V{{ activeBatch.baseRevision }}）</span><span>现场值</span><span>状态</span>
        </div>
        <div v-for="change in activeBatch.changes" :key="change.id" class="change-row">
          <template v-if="fieldDisplay(change) && change.type === 'stepField'">
            <span class="change-target">
              <strong>{{ change.stepId }} · {{ stepTitle(change.stepId) }}</strong>
              <small>{{ FIELD_LABELS[change.field] }} · {{ change.author }} · {{ fmtTime(change.updatedAt) }}</small>
            </span>
            <span class="baseline-val">{{ fieldDisplay(change)?.baseline }}</span>
            <span class="local-val">{{ fieldDisplay(change)?.value }}</span>
            <span class="change-badge" :class="changeState(change).cls">
              <q-icon :name="changeState(change).icon" size="14px" />{{ changeState(change).label }}
            </span>
          </template>
          <template v-else>
            <span class="change-target">
              <strong>{{ commentFor(change)?.stepId }} · {{ stepTitle(commentFor(change)?.stepId ?? '') }}</strong>
              <small>{{ commentFor(change)?.content }}</small>
            </span>
            <span class="baseline-val">—</span>
            <span class="local-val">{{ commentFor(change)?.author }}</span>
            <span class="change-badge" :class="changeState(change).cls">
              <q-icon :name="changeState(change).icon" size="14px" />{{ changeState(change).label }}
            </span>
          </template>
          <div v-if="blockedReason(change.id)" class="blocked-note">
            <q-icon name="lock" size="13px" /> {{ blockedReason(change.id) }} —— 锁定内容未被覆盖，保留服务端值。
          </div>
        </div>
      </div>

      <!-- 冲突选择 -->
      <div v-if="activeBatch.conflicts.length" class="conflict-zone">
        <h3><q-icon name="merge_type" /> 双方改过同一字段（基线 / 办公室 / 平板现场）</h3>
        <div v-for="conflict in activeBatch.conflicts" :key="conflict.changeId" class="conflict-card">
          <div class="conflict-info">
            <strong>{{ conflict.stepId }} · {{ stepTitle(conflict.stepId) }} — {{ FIELD_LABELS[conflict.field] }}</strong>
            <small>基线 V{{ activeBatch.baseRevision }}：{{ conflict.baselineValue }}</small>
          </div>
          <q-option-group
            :model-value="conflict.resolution ?? null"
            :options="[
              { label: `办公室会签值 ${conflict.serverValue}`, value: 'server' },
              { label: `平板现场值 ${conflict.localValue}`, value: 'local' }
            ]"
            color="primary"
            inline
            @update:model-value="(v) => store.resolveConflict(conflict.changeId, v)"
          />
          <q-icon v-if="conflict.resolution" :name="conflict.resolution === 'local' ? 'tablet' : 'corporate_fare'" :color="conflict.resolution === 'local' ? 'deep-orange' : 'primary'" size="22px" />
        </div>
      </div>

      <!-- 风险失效结果 -->
      <div v-if="activeBatch.riskReport" class="risk-zone" :class="{ alert: activeBatch.riskReport.newFindings.length }">
        <h3>
          <q-icon :name="activeBatch.riskReport.newFindings.length ? 'gpp_bad' : 'verified_user'" />
          合并后净空 / 荷载率复核
        </h3>
        <p v-if="!activeBatch.riskReport.newFindings.length" class="risk-ok">未因合并产生新风险，会签结论保持有效。</p>
        <template v-else>
          <ul>
            <li v-for="finding in activeBatch.riskReport.newFindings" :key="`${finding.stepId}-${finding.field}`">
              <strong>{{ finding.stepId }}</strong>：{{ finding.message }}
            </li>
          </ul>
          <div class="risk-actions-taken">
            <q-badge color="negative">原会签结论失效</q-badge>
            <q-badge color="deep-orange">重新打开 {{ activeBatch.riskReport.reopenedCommentIds.length }} 条相关意见</q-badge>
            <q-badge color="primary">已对齐 V{{ activeBatch.finalRevision }} 并刷新就绪度 / 冲突 / 快照</q-badge>
          </div>
        </template>
      </div>
    </section>

    <!-- 无批次时 -->
    <section v-else class="content-panel empty-batch">
      <q-icon name="inbox" size="42px" color="grey-5" />
      <h2>当前没有待同步的离线批次</h2>
      <p>在「模型与参数」或「冲突与评论」里改动步骤、提交意见，系统会按基线版本、修改人和字段值自动记录为批次。</p>
      <q-btn outline color="primary" no-caps icon="cloud_download" label="拉取当前锁定版本与会签意见" :disable="!store.online" @click="store.pullServer()" />
    </section>

    <!-- 历史批次 / 草稿找回 -->
    <section v-if="store.finishedBatches.length" class="content-panel history-panel">
      <div class="panel-heading compact history-head">
        <div>
          <span class="panel-kicker">LOCAL DRAFTS</span>
          <h2>历史批次与本地草稿找回</h2>
        </div>
      </div>
      <div v-for="batch in store.finishedBatches" :key="batch.id" class="history-row">
        <div>
          <strong>{{ batch.id.slice(-8).toUpperCase() }}</strong>
          <small>
            {{ fmtTime(batch.createdAt) }} · 基线 V{{ batch.baseRevision }} · {{ batch.changes.length }} 项 ·
            <q-badge :color="statusLabel(batch).color" dense>{{ statusLabel(batch).text }}</q-badge>
          </small>
        </div>
        <q-btn dense outline no-caps icon="restore" label="找回待同步内容" @click="store.recoverBatch(batch.id)" />
      </div>
    </section>

    <!-- 演练台 -->
    <section class="content-panel demo-panel">
      <div class="panel-heading compact">
        <div>
          <span class="panel-kicker">DRILL CONSOLE</span>
          <h2>断网会签演练台（模拟服务端事件）</h2>
        </div>
        <q-btn flat dense no-caps icon="restart_alt" label="复位演练环境" color="negative" @click="store.devResetAll()" />
      </div>
      <div class="demo-grid">
        <label>
          步骤
          <q-select
            v-model="demoStep"
            :options="store.steps.map((s) => ({ label: `${s.id} ${s.title}`, value: s.id }))"
            outlined
            dense
            emit-value
            map-options
          />
        </label>
        <label>
          字段
          <q-select
            v-model="demoField"
            :options="[
              { label: '最小净空', value: 'clearance' },
              { label: '荷载率', value: 'loadRate' },
              { label: '风速', value: 'wind' },
              { label: '作业半径', value: 'radius' }
            ]"
            outlined
            dense
            emit-value
            map-options
          />
        </label>
        <label>
          服务端改成
          <q-input v-model="demoValue" outlined dense />
        </label>
      </div>
      <div class="demo-actions">
        <q-btn no-caps outline icon="corporate_fare" label="① 办公室同事并改同字段" @click="runCoworkerConflict" />
        <q-btn no-caps outline icon="lock_clock" label="② 会签锁定该字段" @click="runLockField" />
        <q-btn no-caps outline icon="gpp_good" label="③ 四角色先完成会签" @click="runSignOffThenRisk" />
        <q-btn no-caps outline icon="cloud_off" label="④ 下一次提交注入同步失败" @click="runFailures" />
        <q-btn no-caps outline icon="lock" color="negative" label="⑤ 服务端锁定发布方案" @click="runLockPlan" />
      </div>
      <ol class="demo-guide">
        <li>顶部切「断网」→ 在参数页修改 S-03 净空（如 1.1m）并保存，意见也可提交。</li>
        <li>点①模拟同事在办公室改同一字段；点③让四角色先完成会签。</li>
        <li>切回「联网」或点「立即同步」：同字段冲突会列出基线 / 办公室 / 现场三个值供选择。</li>
        <li>处理完冲突后完成合并：净空越过 1.5m 阈值 → 新风险 → 会签失效、S-03 相关意见重开、就绪度下降。</li>
        <li>点④再同步可验证失败重试：批次保留、倒计时自动重试、已成功字段不重复入库。</li>
      </ol>
    </section>
  </div>
</template>
