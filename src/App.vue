<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import * as THREE from 'three';
import { useLiftStore } from './store';
import { FIELD_LABELS } from './offline/types';
import type { StepField, StepParams } from './offline/types';

const SyncCenter = defineAsyncComponent(() => import('./pages/SyncCenter.vue'));

const route = useRoute();
const router = useRouter();
const store = useLiftStore();
const $q = useQuasar();
const canvasRef = ref<HTMLCanvasElement | null>(null);
const sceneContainer = ref<HTMLElement | null>(null);
const commentText = ref('');
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
  { path: '/review', label: '多角色会签', icon: 'fact_check' },
  { path: '/sync', label: '离线同步', icon: 'sync' }
];

const pageTitle = computed(() => nav.find((item) => item.path === route.path)?.label ?? '吊装工作台');

function go(path: string) {
  router.push(path);
}

function severityLabel(severity: string) {
  return severity === 'high' ? '阻断' : '预警';
}

function toast(message: string) {
  $q.notify({ message, color: store.lastMessageTone === 'negative' ? 'negative' : store.lastMessageTone === 'warning' ? 'warning' : store.lastMessageTone === 'positive' ? 'positive' : 'dark', position: 'top-right' });
}

watch(
  () => store.lastMessage,
  (message) => {
    if (message) toast(message);
  }
);

// ---------- 检查器本地表单：编辑在本机，保存时才进入离线批次 ----------
const form = reactive<StepParams>({ ...store.selectedStep });

function loadForm(step: StepParams) {
  Object.assign(form, step);
}
watch(
  () => store.selectedStepId,
  () => loadForm(store.selectedStep)
);
watch(
  () => store.steps,
  () => loadForm(store.selectedStep),
  { deep: true }
);

const dirtyFields = computed<StepField[]>(() => {
  const current = store.selectedStep;
  return (['time', 'loadRate', 'clearance', 'wind', 'radius', 'boom', 'status', 'note'] as StepField[]).filter(
    (field) => String(form[field]) !== String(current[field])
  );
});

function baselineOf(field: StepField): string {
  const batch = store.activeBatch;
  const base = batch?.baselineSteps.find((step) => step.id === store.selectedStepId);
  if (base) return String(base[field]);
  return String(store.selectedStep[field]);
}

function saveForm() {
  store.saveStep(store.selectedStepId, {
    time: form.time,
    loadRate: Number(form.loadRate),
    clearance: Number(form.clearance),
    wind: Number(form.wind),
    radius: Number(form.radius),
    boom: Number(form.boom),
    status: form.status,
    note: form.note
  });
  loadForm(store.selectedStep);
}

function submitComment() {
  store.addComment(commentText.value);
  commentText.value = '';
}

function reviewerStateLabel(state: string) {
  return state === 'accepted' ? '已接受' : state === 'reserved' ? '有保留' : '待确认';
}
function reviewerStateColor(state: string) {
  return state === 'accepted' ? 'positive' : state === 'reserved' ? 'warning' : 'grey';
}

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

onMounted(() => {
  store.startup();
  nextTick(initializeScene);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  resizeObserver?.disconnect();
  renderer?.dispose();
  store.clearRetry();
});
</script>

<template>
  <q-layout view="hHh Lpr lFf" class="app-shell">
    <q-header elevated class="topbar">
      <q-toolbar>
        <div class="brand-mark">LIFT</div>
        <div class="brand-copy">
          <strong>大型构件吊装三维校核</strong>
          <span>
            本地 V{{ store.workingRevision }} · 服务端 V{{ store.serverMeta.revision }} ·
            {{ store.locked ? '已锁定发布' : '会签中' }}
          </span>
        </div>
        <q-space />
        <q-btn-toggle
          :model-value="store.online ? 'online' : 'offline'"
          spread
          no-caps
          dense
          toggle-color="primary"
          color="grey-8"
          :options="[
            { label: '联网', value: 'online' },
            { label: '断网', value: 'offline' }
          ]"
          @update:model-value="(v) => store.setOnline(v === 'online')"
        />
        <q-badge :color="store.online ? 'teal' : 'orange'" outline class="status-badge">
          <q-icon :name="store.online ? 'cloud_done' : 'cloud_off'" size="12px" />{{ store.online ? '在线' : '离线' }}
        </q-badge>
        <q-badge v-if="store.pendingBatches.length" color="deep-orange" class="status-badge">
          {{ store.pendingBatches.length }} 个批次待同步
        </q-badge>
        <q-btn dense flat round icon="notifications" aria-label="通知" @click="go('/sync')">
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
          <q-item-section v-else-if="item.path === '/sync' && store.pendingBatches.length" side>
            <q-badge color="deep-orange">{{ store.pendingBatches.length }}</q-badge>
          </q-item-section>
        </q-item>
      </q-list>
      <div class="draft-state" :class="{ offline: !store.online }">
        <q-icon :name="store.online ? 'cloud_done' : 'cloud_off'" :color="store.online ? 'teal' : 'orange'" />
        <span>
          {{ store.online ? '草稿已自动保存' : '离线草稿本机保存中' }}<br />
          <small>{{ store.deviceName }} · {{ store.currentUser }}</small>
        </span>
      </div>
    </q-drawer>

    <q-page-container>
      <q-page class="workspace-page">
        <!-- 全局横幅 -->
        <q-banner v-if="!store.online" class="offline-banner" rounded>
          <template #avatar><q-icon name="cloud_off" color="orange-9" /></template>
          平板处于断网状态：步骤参数与意见改动会写入离线批次，记录基线版本、修改人和字段值；回到办公室联网后再合并。
        </q-banner>
        <q-banner v-if="store.draftRecovered && store.online" class="recover-banner" rounded>
          <template #avatar><q-icon name="restore" color="blue-9" /></template>
          已从本机找回未完成离线批次，待同步内容仍在。
          <template #action>
            <q-btn flat no-caps label="去同步" @click="go('/sync')" />
          </template>
        </q-banner>
        <q-banner v-if="!store.signOff.valid && store.signOff.invalidatedAt" class="invalid-banner" rounded>
          <template #avatar><q-icon name="gpp_bad" color="red-10" /></template>
          原会签结论已失效：{{ store.signOff.reason }}。相关意见已重新打开，需重新会签。
          <template #action>
            <q-btn flat no-caps label="查看看法" @click="go('/review')" />
          </template>
        </q-banner>

        <header class="page-heading">
          <div>
            <div class="eyebrow">LP-2026-0918 / {{ pageTitle }}</div>
            <h1>{{ pageTitle }}</h1>
          </div>
          <div class="heading-actions">
            <q-btn outline no-caps icon="ios_share" label="导出吊装指令" />
            <q-btn
              color="primary"
              no-caps
              icon="lock"
              :label="store.locked ? '版本已锁定' : '确认并锁定'"
              :disable="store.locked || store.conflicts.length > 0 || store.openComments.length > 0 || !!store.activeBatch"
              @click="store.lockPlan()"
            />
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
                v-for="step in store.steps"
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
                <span class="panel-kicker">STEP INSPECTOR · 基线 V{{ store.activeBatch?.baseRevision ?? store.workingRevision }}</span>
                <h2>{{ store.selectedStep.id }} · {{ store.selectedStep.title }}</h2>
              </div>
              <q-badge v-if="store.activeBatch" color="deep-orange" outline>
                本批已改 {{ store.activeBatch.changes.length }} 项
              </q-badge>
            </div>
            <div class="metric-grid">
              <div><span>荷载率</span><strong :class="{ danger: store.selectedStep.loadRate > 90 }">{{ store.selectedStep.loadRate }}%</strong></div>
              <div><span>最小净空</span><strong :class="{ danger: store.selectedStep.clearance < 1.5 }">{{ store.selectedStep.clearance }}m</strong></div>
              <div><span>作业半径</span><strong>{{ store.selectedStep.radius }}m</strong></div>
              <div><span>风速限制</span><strong>{{ store.selectedStep.wind }}m/s</strong></div>
            </div>

            <div v-if="dirtyFields.length" class="dirty-hint">
              <q-icon name="edit_note" size="15px" />
              待入批：{{ dirtyFields.map((f) => FIELD_LABELS[f]).join('、') }}
            </div>

            <label class="field-label">
              荷载率 <small class="baseline-hint">基线 {{ baselineOf('loadRate') }}%</small>
              <q-badge v-if="store.isFieldLocked(store.selectedStepId, 'loadRate')" color="negative" dense class="lock-badge"><q-icon name="lock" size="10px" />会签锁定</q-badge>
            </label>
            <q-slider v-model="form.loadRate" :min="0" :max="120" color="primary" :disable="store.isFieldLocked(store.selectedStepId, 'loadRate')" />
            <div class="form-row">
              <q-input v-model.number="form.clearance" type="number" label="最小净空 / m" outlined dense hint="基线值影响合并后风险重算" :disable="store.isFieldLocked(store.selectedStepId, 'clearance')">
                <template v-if="store.isFieldLocked(store.selectedStepId, 'clearance')" append><q-icon name="lock" color="negative" /></template>
              </q-input>
              <q-input v-model.number="form.wind" type="number" label="风速 / m/s" outlined dense :disable="store.isFieldLocked(store.selectedStepId, 'wind')">
                <template v-if="store.isFieldLocked(store.selectedStepId, 'wind')" append><q-icon name="lock" color="negative" /></template>
              </q-input>
            </div>
            <div class="form-row">
              <q-input v-model.number="form.radius" type="number" label="作业半径 / m" outlined dense :disable="store.isFieldLocked(store.selectedStepId, 'radius')" />
              <q-input v-model.number="form.boom" type="number" label="臂长 / m" outlined dense :disable="store.isFieldLocked(store.selectedStepId, 'boom')" />
            </div>
            <div class="form-row">
              <q-input v-model="form.time" type="time" label="开始时间" outlined dense mask="HH:mm" :disable="store.isFieldLocked(store.selectedStepId, 'time')" />
            </div>
            <label class="field-label">步骤结论</label>
            <q-btn-toggle
              v-model="form.status"
              spread
              no-caps
              toggle-color="primary"
              :disable="store.isFieldLocked(store.selectedStepId, 'status')"
              :options="[
                { label: '待复核', value: 'pending' },
                { label: '通过', value: 'passed' },
                { label: '阻断', value: 'blocked' }
              ]"
            />
            <q-input v-model="form.note" type="textarea" autogrow outlined label="现场控制说明" class="note-input" :disable="store.isFieldLocked(store.selectedStepId, 'note')" />
            <q-btn class="save-step" color="primary" no-caps icon="save" :label="`保存到${store.online ? '同步' : '离线'}批次`" @click="saveForm" />
            <div class="inspector-foot">
              <q-icon :name="store.online ? 'cloud_queue' : 'save'" size="14px" />
              <span>
                每项改动记录基线版本、修改人（{{ store.currentUser }}）与字段值；同一字段重复修改只更新现场值。
              </span>
            </div>
          </aside>
        </section>

        <section v-if="route.path === '/checks'" class="content-panel full-panel">
          <div class="panel-heading">
            <div>
              <span class="panel-kicker">RULE ENGINE · V{{ store.workingRevision }}</span>
              <h2>冲突定位与条件清单</h2>
            </div>
            <q-badge color="negative">{{ store.conflicts.length }} 项待处理</q-badge>
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
              <div v-for="comment in store.comments.filter((c) => c.stepId === store.selectedStepId)" :key="comment.id" class="comment-row">
                <div class="comment-avatar">{{ comment.author.slice(0, 1) }}</div>
                <div>
                  <strong>{{ comment.author }} <small>{{ comment.role }}</small></strong>
                  <p>{{ comment.content }}</p>
                  <div v-if="comment.reopenedReason" class="reopened-tag">
                    <q-icon name="history" size="12px" /> {{ comment.reopenedReason }}
                  </div>
                  <button v-if="comment.status === 'open'" @click="store.resolveComment(comment.id)">标记已解决</button>
                  <span v-else class="resolved">已解决</span>
                </div>
              </div>
              <q-input v-model="commentText" type="textarea" outlined autogrow label="对该步骤提出条件或补充意见（断网也可提交）" />
              <q-btn color="primary" no-caps icon="send" label="提交意见" @click="submitComment" />
            </div>
          </div>
        </section>

        <section v-if="route.path === '/review'" class="content-panel full-panel">
          <div class="panel-heading">
            <div>
              <span class="panel-kicker">MULTI-PARTY SIGN-OFF · V{{ store.workingRevision }}</span>
              <h2>多角色会签与发布门禁</h2>
            </div>
            <div class="readiness"><strong>{{ store.readiness }}%</strong><span>发布就绪度</span></div>
          </div>
          <q-banner v-if="!store.signOff.valid && store.signOff.invalidatedAt" class="inline-invalid" dense rounded>
            <template #avatar><q-icon name="warning" color="red-10" /></template>
            V{{ store.signOff.revision }} 的会签结论因合并后新风险失效，相关意见已重新打开，需要重新完成会签。
          </q-banner>
          <div class="review-grid">
            <article v-for="person in store.reviewers" :key="person.id" class="review-card">
              <div class="review-head">
                <strong>{{ person.name }}</strong>
                <q-badge :color="reviewerStateColor(person.state)">{{ reviewerStateLabel(person.state) }}</q-badge>
              </div>
              <span>{{ person.team }}</span>
              <p>{{ person.scope }}</p>
              <q-btn v-if="person.state !== 'accepted'" outline no-caps label="接受方案" />
              <q-btn v-else disable no-caps label="已签署" />
            </article>
          </div>
          <div class="release-gate">
            <div>
              <q-icon name="verified_user" size="30px" />
              <div>
                <strong>发布前门禁</strong>
                <span>要求冲突清零、意见全部关闭、离线批次全部合并、四个角色完成签署。</span>
              </div>
            </div>
            <q-btn
              color="primary"
              no-caps
              icon="lock"
              label="锁定并发布 V{{ store.serverMeta.revision + 1 }}"
              :disable="store.conflicts.length > 0 || store.openComments.length > 0 || !!store.activeBatch"
              @click="store.lockPlan()"
            />
          </div>
        </section>

        <SyncCenter v-if="route.path === '/sync'" />
      </q-page>
    </q-page-container>
  </q-layout>
</template>
