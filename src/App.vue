<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import * as THREE from 'three';
import { useLiftStore } from './store';

const route = useRoute();
const router = useRouter();
const store = useLiftStore();
const canvasRef = ref<HTMLCanvasElement | null>(null);
const commentText = ref('');
const sceneContainer = ref<HTMLElement | null>(null);
const syncCenterOpen = ref(false);
let renderer: THREE.WebGLRenderer | null = null;
let frame = 0;
let resizeObserver: ResizeObserver | null = null;
let theta = 0.8;
let phi = 0.9;
let dragging = false;
let previousX = 0;

const nav = [
  { path: '/', label: '三维复核', icon: 'view_in_ar' },
  { path: '/models', label: '模型与参数', icon: 'tune' },
  { path: '/checks', label: '冲突与评论', icon: 'rule' },
  { path: '/review', label: '多角色会签', icon: 'fact_check' }
];

const pageTitle = computed(() => nav.find((item) => item.path === route.path)?.label ?? '吊装工作台');

const pendingCount = computed(() => store.pendingBatches.length + store.openFieldConflicts.length);

function go(path: string) {
  router.push(path);
}

function severityLabel(severity: string) {
  return severity === 'high' ? '阻断' : '预警';
}

function submitComment() {
  store.addComment(commentText.value);
  commentText.value = '';
}

function resolveConflict(conflictId: string, resolution: 'local' | 'server') {
  store.resolveFieldConflict(conflictId, resolution);
}

function fieldConflictTitle(conflict: { stepId: string; field: string }) {
  const step = store.steps.find((s) => s.id === conflict.stepId);
  const fieldLabels: Record<string, string> = {
    loadRate: '荷载率',
    clearance: '净空',
    wind: '风速',
    radius: '作业半径',
    boom: '臂长',
    status: '步骤结论',
    note: '现场控制说明'
  };
  return `${step?.title ?? conflict.stepId} · ${fieldLabels[conflict.field] ?? conflict.field}`;
}

function formatValue(value: number | string) {
  if (typeof value === 'number') return `${value}`;
  return value;
}

function statusLabel(status: string) {
  const map: Record<string, string> = {
    pending: '待同步',
    syncing: '同步中',
    conflict: '待处理冲突',
    failed: '同步失败',
    synced: '已同步'
  };
  return map[status] ?? status;
}

function statusColor(status: string) {
  const map: Record<string, string> = {
    pending: 'orange',
    syncing: 'blue',
    conflict: 'red',
    failed: 'red',
    synced: 'teal'
  };
  return map[status] ?? 'grey';
}

function onOnline() {
  store.setOnline(true);
}
function onOffline() {
  store.setOnline(false);
}

// 步骤改动写入离线批次（断网排队、联网逐字段合并）
watch(
  () => store.steps,
  () => {
    if (store.syncing) return;
    store.recordChanges();
    if (store.effectiveOnline) void store.syncAll();
  },
  { deep: true }
);

onMounted(() => {
  nextTick(initializeScene);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  if (store.effectiveOnline) void store.syncAll();
});

onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  resizeObserver?.disconnect();
  renderer?.dispose();
  window.removeEventListener('online', onOnline);
  window.removeEventListener('offline', onOffline);
});

function initializeScene() {
  if (!canvasRef.value || !sceneContainer.value) return;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#dce6e1');
  scene.fog = new THREE.Fog('#dce6e1', 34, 78);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 160);
  renderer = new THREE.WebGLRenderer({ canvas: canvasRef.value, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  scene.add(new THREE.HemisphereLight('#eefaf5', '#273b34', 2.3));
  const sun = new THREE.DirectionalLight('#fff4d6', 3.2);
  sun.position.set(14, 28, 18);
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 44),
    new THREE.MeshStandardMaterial({ color: '#b8c7bf', roughness: 0.95 })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const grid = new THREE.GridHelper(60, 30, '#80948a', '#a8b8b0');
  grid.position.y = 0.02;
  scene.add(grid);

  const steel = new THREE.MeshStandardMaterial({ color: '#ec7a3c', roughness: 0.48, metalness: 0.35 });
  const darkSteel = new THREE.MeshStandardMaterial({ color: '#2d5c4f', roughness: 0.58, metalness: 0.42 });
  const truss = new THREE.Group();
  const chordGeometry = new THREE.BoxGeometry(18, 1.1, 1.1);
  for (const z of [-3.5, 3.5]) {
    for (const y of [4.2, 8.4]) {
      const chord = new THREE.Mesh(chordGeometry, steel);
      chord.position.set(0, y, z);
      truss.add(chord);
    }
  }
  for (let x = -8; x <= 8; x += 2) {
    const brace = new THREE.Mesh(new THREE.BoxGeometry(0.34, 4.8, 0.34), steel);
    brace.position.set(x, 6.2, -3.5);
    brace.rotation.z = x % 4 === 0 ? 0.36 : -0.36;
    truss.add(brace);
    const cross = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 7), darkSteel);
    cross.position.set(x, 4.2, 0);
    truss.add(cross);
  }
  truss.position.set(0, 6.5, 2);
  scene.add(truss);

  const crane = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(7, 1.2, 5), darkSteel);
  base.position.y = 0.6;
  crane.add(base);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(3, 2.7, 3), new THREE.MeshStandardMaterial({ color: '#d8a733' }));
  cabin.position.set(-1, 2.5, 0);
  crane.add(cabin);
  const mast = new THREE.Mesh(new THREE.BoxGeometry(1.2, 24, 1.2), darkSteel);
  mast.position.y = 12;
  crane.add(mast);
  const boom = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 36), steel);
  boom.position.set(-8.5, 20.5, 9.5);
  boom.rotation.set(-0.38, 0.7, 0.14);
  crane.add(boom);
  crane.position.set(-15, 0, -12);
  scene.add(crane);

  const obstacleMat = new THREE.MeshStandardMaterial({ color: '#d34c45', transparent: true, opacity: 0.38 });
  const obstacle = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 4), obstacleMat);
  obstacle.position.set(10, 2.5, 8);
  scene.add(obstacle);
  scene.add(new THREE.BoxHelper(obstacle, '#a92d2a'));

  const updateCamera = () => {
    const radius = 48;
    camera.position.set(
      Math.sin(theta) * Math.sin(phi) * radius,
      Math.cos(phi) * radius + 12,
      Math.cos(theta) * Math.sin(phi) * radius
    );
    camera.lookAt(0, 7, 0);
  };

  const render = () => {
    frame = requestAnimationFrame(render);
    truss.position.y = 6.5 + Math.sin(Date.now() / 900) * 0.08;
    updateCamera();
    renderer?.render(scene, camera);
  };
  render();

  const resize = () => {
    if (!sceneContainer.value || !renderer) return;
    const { width, height } = sceneContainer.value.getBoundingClientRect();
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
  };
  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(sceneContainer.value);
  resize();

  canvasRef.value.onpointerdown = (event) => {
    dragging = true;
    previousX = event.clientX;
    canvasRef.value?.setPointerCapture(event.pointerId);
  };
  canvasRef.value.onpointermove = (event) => {
    if (!dragging) return;
    theta += (event.clientX - previousX) * 0.006;
    previousX = event.clientX;
  };
  canvasRef.value.onpointerup = () => {
    dragging = false;
  };
}
</script>

<template>
  <q-layout view="hHh Lpr lFf" class="app-shell">
    <q-header elevated class="topbar">
      <q-toolbar>
        <div class="brand-mark">LIFT</div>
        <div class="brand-copy">
          <strong>大型构件吊装三维校核</strong>
          <span>东塔转换桁架 · 方案版本 V{{ store.revision }}</span>
        </div>
        <q-space />
        <q-btn
          dense
          :flat="!store.hasPendingSync"
          :color="store.effectiveOnline ? 'teal' : 'orange'"
          no-caps
          icon="sync"
          :label="store.effectiveOnline ? '在线' : '离线'"
          @click="syncCenterOpen = true"
        >
          <q-badge v-if="pendingCount > 0" floating color="red">{{ pendingCount }}</q-badge>
        </q-btn>
        <q-btn dense flat round :icon="store.forceOffline ? 'cloud_off' : 'cloud'" aria-label="切换离线模式" @click="store.toggleForceOffline()">
          <q-tooltip>{{ store.forceOffline ? '当前强制离线，点击恢复联网' : '模拟断网（离线变更将排队）' }}</q-tooltip>
        </q-btn>
        <q-badge :color="store.locked ? 'teal' : 'orange'" outline class="status-badge">
          {{ store.locked ? '已锁定发布' : '会签中' }}
        </q-badge>
        <q-btn dense flat round icon="notifications" aria-label="通知">
          <q-badge floating color="red">{{ store.openComments.length }}</q-badge>
        </q-btn>
      </q-toolbar>
    </q-header>

    <q-drawer show-if-above side="left" :width="232" bordered class="left-nav">
      <div class="drawer-section-label">方案工作区</div>
      <q-list padding>
        <q-item
          v-for="item in nav"
          :key="item.path"
          clickable
          :active="route.path === item.path"
          active-class="nav-active"
          @click="go(item.path)"
        >
          <q-item-section avatar><q-icon :name="item.icon" /></q-item-section>
          <q-item-section>{{ item.label }}</q-item-section>
          <q-item-section v-if="item.path === '/checks'" side>
            <q-badge color="negative">{{ store.conflicts.length }}</q-badge>
          </q-item-section>
        </q-item>
      </q-list>
      <div class="draft-state">
        <q-icon name="cloud_done" color="teal" />
        <span>草稿已自动保存<br /><small>{{ new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</small></span>
      </div>
    </q-drawer>

    <q-page-container>
      <q-page class="workspace-page">
        <header class="page-heading">
          <div>
            <div class="eyebrow">LP-2026-0918 / {{ pageTitle }}</div>
            <h1>{{ pageTitle }}</h1>
          </div>
          <div class="heading-actions">
            <q-btn outline no-caps icon="ios_share" label="导出吊装指令" />
            <q-btn color="primary" no-caps icon="lock" :label="store.locked ? '版本已锁定' : '确认并锁定'" :disable="store.locked || store.conflicts.length > 0 || store.openComments.length > 0" @click="store.lockPlan" />
          </div>
        </header>

        <section v-if="route.path === '/' || route.path === '/models'" class="work-grid">
          <article class="scene-panel content-panel">
            <div class="panel-heading">
              <div>
                <span class="panel-kicker">THREE.JS SCENE</span>
                <h2>吊装姿态与空间冲突</h2>
              </div>
              <div class="view-bookmarks">
                <button
                  v-for="bookmark in store.viewBookmarks"
                  :key="bookmark"
                  :class="{ active: store.activeBookmark === bookmark }"
                  @click="store.setBookmark(bookmark)"
                >
                  {{ bookmark }}
                </button>
              </div>
            </div>
            <div ref="sceneContainer" class="scene-container">
              <canvas ref="canvasRef" aria-label="吊装三维场景" />
              <div class="scene-legend">
                <span><i class="legend-dot crane" />主吊</span>
                <span><i class="legend-dot load" />构件</span>
                <span><i class="legend-dot risk" />障碍物</span>
              </div>
              <div class="scene-hint">拖动旋转视角 · 滚轮缩放由设备手势控制</div>
            </div>
            <div class="timeline">
              <button
                v-for="(step, index) in store.steps"
                :key="step.id"
                class="timeline-step"
                :class="[step.status, { selected: store.selectedStepId === step.id }]"
                @click="store.selectStep(step.id)"
              >
                <span>{{ step.time }}</span>
                <strong>{{ step.title }}</strong>
                <small>{{ step.loadRate }}% 荷载 · {{ step.clearance }}m 净空</small>
              </button>
            </div>
          </article>

          <aside class="inspector-panel content-panel">
            <div class="panel-heading compact">
              <div>
                <span class="panel-kicker">STEP INSPECTOR</span>
                <h2>{{ store.selectedStep.id }} · {{ store.selectedStep.title }}</h2>
              </div>
            </div>
            <div class="metric-grid">
              <div><span>荷载率</span><strong :class="{ danger: store.selectedStep.loadRate > 90 }">{{ store.selectedStep.loadRate }}%</strong></div>
              <div><span>最小净空</span><strong :class="{ danger: store.selectedStep.clearance < 1.5 }">{{ store.selectedStep.clearance }}m</strong></div>
              <div><span>作业半径</span><strong>{{ store.selectedStep.radius }}m</strong></div>
              <div><span>风速限制</span><strong>{{ store.selectedStep.wind }}m/s</strong></div>
            </div>
            <label class="field-label">荷载率</label>
            <q-slider v-model="store.selectedStep.loadRate" :min="0" :max="120" color="primary" />
            <div class="form-row">
              <q-input v-model.number="store.selectedStep.clearance" type="number" label="最小净空 / m" outlined dense />
              <q-input v-model.number="store.selectedStep.wind" type="number" label="风速 / m/s" outlined dense />
            </div>
            <label class="field-label">步骤结论</label>
            <q-btn-toggle
              v-model="store.selectedStep.status"
              spread
              no-caps
              toggle-color="primary"
              :options="[
                { label: '待复核', value: 'pending' },
                { label: '通过', value: 'passed' },
                { label: '阻断', value: 'blocked' }
              ]"
            />
            <q-input v-model="store.selectedStep.note" type="textarea" autogrow outlined label="现场控制说明" class="note-input" />
            <q-btn class="save-step" color="primary" no-caps icon="save" label="保存步骤修改" @click="store.updateStep({})" />
          </aside>
        </section>

        <section v-if="route.path === '/checks'" class="content-panel full-panel">
          <div class="panel-heading">
            <div>
              <span class="panel-kicker">RULE ENGINE</span>
              <h2>冲突定位与条件清单</h2>
            </div>
            <q-badge color="negative">{{ store.conflicts.length }} 项规则冲突 · {{ store.openFieldConflicts.length }} 项字段冲突</q-badge>
          </div>

          <div v-if="store.openFieldConflicts.length > 0" class="field-conflict-strip">
            <div class="strip-head">
              <q-icon name="sync_problem" color="red" />
              <strong>离线字段合并冲突（需选择后才能入库）</strong>
            </div>
            <div v-for="conflict in store.openFieldConflicts" :key="conflict.id" class="strip-item">
              <div class="strip-info">
                <strong>{{ fieldConflictTitle(conflict) }}</strong>
                <small>基线 {{ formatValue(conflict.baseValue) }} · 本地 {{ formatValue(conflict.localValue) }} · 远端 {{ formatValue(conflict.serverValue) }}</small>
              </div>
              <div class="strip-actions">
                <q-btn size="xs" outline color="primary" no-caps label="采用本地" @click="resolveConflict(conflict.id, 'local')" />
                <q-btn size="xs" outline color="primary" no-caps label="采用远端" @click="resolveConflict(conflict.id, 'server')" />
              </div>
            </div>
          </div>

          <div class="check-layout">
            <div class="conflict-list">
              <button v-for="item in store.conflicts" :key="item.id" class="conflict-item" @click="store.selectStep(item.stepId)">
                <span class="severity" :class="item.severity">{{ severityLabel(item.severity) }}</span>
                <div><strong>{{ item.stepId }} · {{ item.title }}</strong><small>{{ item.message }}</small></div>
                <q-icon name="arrow_forward" />
              </button>
              <div v-if="store.conflicts.length === 0" class="empty-state">当前版本未发现规则冲突。</div>
            </div>
            <div class="comments-panel">
              <h3>条件与评论 · {{ store.selectedStep.id }}</h3>
              <div v-for="comment in store.comments.filter(c => c.stepId === store.selectedStepId)" :key="comment.id" class="comment-row">
                <div class="comment-avatar">{{ comment.author.slice(0, 1) }}</div>
                <div>
                  <strong>{{ comment.author }} <small>{{ comment.role }}</small></strong>
                  <p>{{ comment.content }}</p>
                  <button v-if="comment.status === 'open'" @click="store.resolveComment(comment.id)">标记已解决</button>
                  <span v-else class="resolved">已解决</span>
                </div>
              </div>
              <q-input v-model="commentText" type="textarea" outlined autogrow label="对该步骤提出条件或补充意见" />
              <q-btn color="primary" no-caps icon="send" label="提交意见" @click="submitComment" />
            </div>
          </div>
        </section>

        <section v-if="route.path === '/review'" class="content-panel full-panel">
          <div class="panel-heading">
            <div>
              <span class="panel-kicker">MULTI-PARTY SIGN-OFF</span>
              <h2>多角色会签与发布门禁</h2>
            </div>
            <div class="readiness"><strong>{{ store.readiness }}%</strong><span>发布就绪度</span></div>
          </div>

          <div v-if="store.invalidated" class="invalidated-banner review-banner">
            <q-icon name="warning" color="warning" />
            <div>
              <strong>原会签结论已失效</strong>
              <span>净空或荷载率因合并变化产生新风险，相关意见已重新打开，签署角色已回到待确认。</span>
            </div>
          </div>

          <div class="review-grid">
            <article v-for="person in store.signoffs" :key="person.id" class="review-card">
              <div class="review-head"><strong>{{ person.name }}</strong><q-badge :color="person.state === 'accepted' ? 'positive' : person.state === 'reserved' ? 'warning' : 'grey'">{{ person.state === 'accepted' ? '已接受' : person.state === 'reserved' ? '有保留' : '待确认' }}</q-badge></div>
              <span>{{ person.team }}</span>
              <p>{{ person.scope }}</p>
              <q-btn v-if="person.state !== 'accepted'" outline no-caps label="接受方案" @click="store.setSignoffState(person.id, 'accepted')" />
              <q-btn v-else disable no-caps label="已签署" />
            </article>
          </div>
          <div class="release-gate">
            <div>
              <q-icon name="verified_user" size="30px" />
              <div><strong>发布前门禁</strong><span>要求冲突清零、意见全部关闭、四个角色完成签署。</span></div>
            </div>
            <q-btn color="primary" no-caps icon="lock" label="锁定并发布 V{{ store.revision + 1 }}" :disable="store.conflicts.length > 0 || store.openComments.length > 0" @click="store.lockPlan" />
          </div>
        </section>
      </q-page>
    </q-page-container>

    <q-dialog v-model="syncCenterOpen" persistent>
      <q-card class="sync-dialog">
        <q-card-section class="sync-dialog-header">
          <div>
            <div class="panel-kicker">OFFLINE SYNC CENTER</div>
            <h3>离线变更同步中心</h3>
          </div>
          <q-btn dense flat round icon="close" @click="syncCenterOpen = false" />
        </q-card-section>
        <q-card-section class="sync-dialog-body">
          <div class="sync-toolbar">
            <div class="sync-status-line">
              <q-icon :name="store.effectiveOnline ? 'cloud_done' : 'cloud_off'" :color="store.effectiveOnline ? 'teal' : 'orange'" />
              <span>{{ store.effectiveOnline ? '已联网，变更将逐字段合并到当前锁定版本' : '离线中，变更将排队待联网后同步' }}</span>
            </div>
            <div class="sync-toolbar-actions">
              <q-btn size="sm" outline no-caps icon="sync" label="立即同步" :disable="!store.effectiveOnline || store.syncing || store.pendingBatches.length === 0" @click="store.syncAll()" />
              <q-btn size="sm" outline no-caps icon="cloud_download" label="模拟远端变更" @click="store.simulateRemoteChange()" />
            </div>
          </div>

          <div v-if="store.invalidated" class="invalidated-banner">
            <q-icon name="warning" color="warning" />
            <div>
              <strong>原会签结论已失效</strong>
              <span>净空或荷载率因合并变化产生新风险，相关意见已重新打开，就绪度已重置。</span>
            </div>
          </div>

          <h4 class="sync-section-title">待同步批次</h4>
          <div v-if="store.batches.length === 0" class="empty-state">暂无离线变更批次。断网后修改步骤参数即会在此生成批次。</div>
          <div v-for="batch in store.batches" :key="batch.id" class="batch-card">
            <div class="batch-head">
              <div>
                <strong>{{ batch.id }}</strong>
                <small>{{ batch.createdBy }} · 基线 V{{ batch.baselineRevision }} · {{ new Date(batch.createdAt).toLocaleString('zh-CN') }}</small>
              </div>
              <q-badge :color="statusColor(batch.status)">{{ statusLabel(batch.status) }}</q-badge>
            </div>
            <div v-if="batch.lastError" class="batch-error">
              <q-icon name="error" color="red" size="14px" />
              <span>同步失败：{{ batch.lastError }}（第 {{ batch.retryCount }} 次重试）</span>
            </div>
            <div class="batch-fields">
              <div v-for="change in batch.changes" :key="change.stepId" class="batch-step">
                <span class="batch-step-id">{{ change.stepId }}</span>
                <span v-for="field in change.fields" :key="field.id" class="batch-field" :class="{ synced: field.synced }">
                  {{ field.field }}: {{ formatValue(field.baseValue) }} → <strong>{{ formatValue(field.localValue) }}</strong>
                  <q-icon v-if="field.synced" name="check_circle" color="teal" size="13px" />
                </span>
              </div>
            </div>
            <div class="batch-actions">
              <q-btn v-if="batch.status === 'failed'" size="xs" color="primary" no-caps icon="refresh" label="重试" @click="store.retryBatch(batch.id)" />
              <span v-if="batch.syncedAt" class="batch-synced-at">已于 {{ new Date(batch.syncedAt).toLocaleTimeString('zh-CN') }} 同步</span>
            </div>
          </div>

          <h4 class="sync-section-title">字段冲突（需选择）</h4>
          <div v-if="store.fieldConflicts.length === 0" class="empty-state">联网合并时若双方改过同一字段，将在此列出供选择。</div>
          <div v-for="conflict in store.fieldConflicts" :key="conflict.id" class="conflict-card" :class="{ resolved: conflict.status === 'resolved' }">
            <div class="conflict-head">
              <strong>{{ fieldConflictTitle(conflict) }}</strong>
              <q-badge v-if="conflict.status === 'open'" color="red">待选择</q-badge>
              <q-badge v-else color="teal">已选择{{ conflict.resolution === 'local' ? '本地' : '远端' }}</q-badge>
            </div>
            <div class="conflict-reason">{{ conflict.reason === 'locked' ? '该内容已锁定，不能被覆盖' : '双方在离线期间都修改了同一字段' }}</div>
            <div class="conflict-values">
              <div class="conflict-value" :class="{ chosen: conflict.status === 'resolved' && conflict.resolution === 'local' }">
                <span class="cv-label">本地（离线）</span>
                <span class="cv-value">{{ formatValue(conflict.localValue) }}</span>
                <q-btn v-if="conflict.status === 'open'" size="xs" outline color="primary" no-caps :disable="conflict.reason === 'locked'" label="采用本地" @click="resolveConflict(conflict.id, 'local')" />
              </div>
              <div class="conflict-value" :class="{ chosen: conflict.status === 'resolved' && conflict.resolution === 'server' }">
                <span class="cv-label">远端（当前版本）</span>
                <span class="cv-value">{{ formatValue(conflict.serverValue) }}</span>
                <q-btn v-if="conflict.status === 'open'" size="xs" outline color="primary" no-caps label="采用远端" @click="resolveConflict(conflict.id, 'server')" />
              </div>
            </div>
          </div>
        </q-card-section>
      </q-card>
    </q-dialog>
  </q-layout>
</template>
