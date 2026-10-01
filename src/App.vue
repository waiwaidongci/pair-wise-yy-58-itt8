<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import * as THREE from 'three';
import { ROLE_SCOPES, fingerprintFor, useLiftStore, type VersionSnapshot } from './store';

const route = useRoute();
const router = useRouter();
const store = useLiftStore();
const canvasRef = ref<HTMLCanvasElement | null>(null);
const commentText = ref('');
const sceneContainer = ref<HTMLElement | null>(null);
let renderer: THREE.WebGLRenderer | null = null;
let frame = 0;
let resizeObserver: ResizeObserver | null = null;
let theta = 0.8;
let phi = 0.9;
let dragging = false;
let previousX = 0;

const signingRole = ref<string | null>(null);
const opinionText = ref('');
const versionDialog = ref(false);
const viewingVersion = ref<VersionSnapshot | null>(null);

const nav = [
  { path: '/', label: '三维复核', icon: 'view_in_ar' },
  { path: '/models', label: '模型与参数', icon: 'tune' },
  { path: '/checks', label: '冲突与评论', icon: 'rule' },
  { path: '/review', label: '多角色会签', icon: 'fact_check' }
];

const pageTitle = computed(() => nav.find((item) => item.path === route.path)?.label ?? '吊装工作台');

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

function sigOf(role: string) {
  return store.signatures.find((item) => item.role === role);
}

function fpOf(role: string) {
  return fingerprintFor(role, store.steps, store.comments);
}

function startSign(role: string) {
  signingRole.value = role;
  opinionText.value = sigOf(role)?.opinion ?? '';
}

async function confirmSign(role: string) {
  await store.signRole(role, opinionText.value);
  signingRole.value = null;
  opinionText.value = '';
}

async function runConcurrent() {
  const target = store.signatures.find((item) => item.status !== 'signed')?.role ?? ROLE_SCOPES[0].role;
  await store.simulateConcurrentSign(target);
}

function badgeColor(status: string) {
  return status === 'signed' ? 'positive' : status === 'stale' ? 'warning' : 'grey';
}

function badgeLabel(status: string) {
  return status === 'signed' ? '已签署' : status === 'stale' ? '已失效' : '待签署';
}

function formatTime(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

function openVersion(version: VersionSnapshot) {
  viewingVersion.value = version;
  versionDialog.value = true;
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
  nextTick(initializeScene);
  store.recoverAll();
});

onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  resizeObserver?.disconnect();
  renderer?.dispose();
});
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
            <q-btn color="primary" no-caps icon="lock" :label="store.locked ? '版本已锁定' : '确认并锁定'" :disable="store.locked || store.conflicts.length > 0 || store.openComments.length > 0 || !store.allSigned" @click="store.lockPlan" />
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

          <div class="batch-bar">
            <div class="batch-meta">
              <span class="batch-id">授权批次 {{ store.batch?.batchId ?? '—' }}</span>
              <span>发起于 {{ formatTime(store.batch?.initiatedAt ?? null) }}</span>
              <q-badge :color="store.batch?.status === 'committed' ? 'teal' : 'orange'">
                {{ store.batch?.status === 'committed' ? '批次已提交' : '会签进行中' }}
              </q-badge>
              <q-badge color="blue-grey">{{ store.signedCount }}/4 已签署</q-badge>
            </div>
            <div class="batch-actions">
              <q-btn outline no-caps size="sm" icon="refresh" label="重新发起复核" @click="store.initiateReview()" />
              <q-btn outline no-caps size="sm" icon="health_and_safety" label="按批次号恢复" @click="store.recoverByBatch(store.batch?.batchId ?? '')" />
              <q-btn outline no-caps size="sm" icon="group" label="模拟两终端同时签署" @click="runConcurrent" />
              <q-toggle v-model="store.simulateWriteFailure" label="模拟写入故障" dense />
            </div>
          </div>

          <q-banner v-if="store.lastNotice" class="notice-banner" :class="`tone-${store.lastNotice.tone}`" rounded dense>
            {{ store.lastNotice.message }}
          </q-banner>
          <q-banner v-if="store.recoveryReport" class="notice-banner tone-info" rounded dense>
            批次恢复报告：批次 {{ store.recoveryReport.batchId }} · {{ store.recoveryReport.role }} 角色 · {{ store.recoveryReport.action === 'completed' ? '整份补全' : '已回滚' }} · {{ formatTime(store.recoveryReport.at) }}
          </q-banner>

          <div class="review-grid">
            <article v-for="scope in ROLE_SCOPES" :key="scope.id" class="review-card" :class="{ stale: sigOf(scope.role)?.status === 'stale' }">
              <div class="review-head">
                <strong>{{ scope.signer }}</strong>
                <q-badge :color="badgeColor(sigOf(scope.role)?.status ?? 'pending')">{{ badgeLabel(sigOf(scope.role)?.status ?? 'pending') }}</q-badge>
              </div>
              <span>{{ scope.team }}</span>
              <p>{{ scope.scope }}</p>
              <div class="fingerprint">
                <template v-if="sigOf(scope.role)?.status === 'stale'">
                  <span class="fp-line">原指纹 <code>{{ sigOf(scope.role)?.fingerprint }}</code></span>
                  <q-icon name="arrow_forward" size="xs" />
                  <span class="fp-line">现指纹 <code>{{ fpOf(scope.role) }}</code></span>
                </template>
                <template v-else>
                  <span class="fp-line">复核指纹 <code>{{ fpOf(scope.role) }}</code></span>
                </template>
              </div>
              <div v-if="sigOf(scope.role)?.status === 'signed'" class="signed-meta">
                <q-icon name="verified" size="xs" />
                <span>{{ sigOf(scope.role)?.signer }} · {{ formatTime(sigOf(scope.role)?.signedAt ?? null) }}</span>
                <div class="opinion">「{{ sigOf(scope.role)?.opinion || '同意按方案施工' }}」</div>
              </div>
              <div v-if="signingRole === scope.role" class="sign-form">
                <q-input v-model="opinionText" dense outlined label="签署意见（可留空）" />
                <div class="sign-form-actions">
                  <q-btn size="sm" color="primary" label="确认签署" @click="confirmSign(scope.role)" />
                  <q-btn size="sm" flat label="取消" @click="signingRole = null" />
                </div>
              </div>
              <q-btn v-else-if="sigOf(scope.role)?.status === 'pending'" outline no-caps label="接受方案" @click="startSign(scope.role)" />
              <q-btn v-else outline no-caps color="warning" label="重新签署" @click="startSign(scope.role)" />
            </article>
          </div>

          <div class="version-panel">
            <div class="version-head">
              <h3>版本记录</h3>
              <span>锁定后生成不可变快照，旧版本继续可查；变更步骤或评论后需按新批次重新签署。</span>
            </div>
            <div v-if="store.versions.length === 0" class="empty-state">尚未发布版本。</div>
            <div v-for="version in store.versions" :key="version.id" class="version-row">
              <div class="version-info">
                <strong>V{{ version.revision }}</strong>
                <q-badge color="teal">{{ version.status }}</q-badge>
                <span class="version-batch">{{ version.batchId }}</span>
                <span>{{ formatTime(version.lockedAt) }}</span>
                <span>{{ version.signatures.filter((s) => s.status === 'signed').length }}/4 签署</span>
              </div>
              <q-btn size="sm" outline no-caps label="查看快照" @click="openVersion(version)" />
            </div>
          </div>

          <div class="release-gate">
            <div>
              <q-icon name="verified_user" size="30px" />
              <div>
                <strong>发布前门禁</strong>
                <span>要求冲突清零、意见全部关闭、四个角色完成签署（{{ store.signedCount }}/4）。</span>
              </div>
            </div>
            <q-btn color="primary" no-caps icon="lock" label="锁定并发布 V{{ store.revision + 1 }}" :disable="store.conflicts.length > 0 || store.openComments.length > 0 || !store.allSigned" @click="store.lockPlan" />
          </div>

          <q-dialog v-model="versionDialog">
            <q-card v-if="viewingVersion" class="version-dialog">
              <q-card-section class="version-dialog-head">
                <div>
                  <div class="eyebrow">VERSION SNAPSHOT</div>
                  <h3>V{{ viewingVersion.revision }} · {{ viewingVersion.batchId }}</h3>
                  <span>锁定于 {{ formatTime(viewingVersion.lockedAt) }}</span>
                </div>
                <q-btn flat round icon="close" @click="versionDialog = false" />
              </q-card-section>
              <q-card-section>
                <div class="snapshot-section-title">步骤（{{ viewingVersion.steps.length }}）</div>
                <div v-for="step in viewingVersion.steps" :key="step.id" class="snapshot-step">
                  <strong>{{ step.id }}</strong>
                  <span>{{ step.title }}</span>
                  <small>{{ step.loadRate }}% · {{ step.clearance }}m · {{ step.wind }}m/s · {{ step.status }}</small>
                </div>
                <div class="snapshot-section-title">评论（{{ viewingVersion.comments.length }}）</div>
                <div v-for="comment in viewingVersion.comments" :key="comment.id" class="snapshot-comment">
                  <strong>{{ comment.author }} · {{ comment.role }}</strong>
                  <span>{{ comment.content }}</span>
                  <small>{{ comment.status === 'open' ? '未关闭' : '已解决' }}</small>
                </div>
                <div class="snapshot-section-title">角色签署（{{ viewingVersion.signatures.filter((s) => s.status === 'signed').length }}/4）</div>
                <div v-for="sig in viewingVersion.signatures" :key="sig.role" class="snapshot-sign">
                  <q-icon name="verified" size="xs" color="teal" />
                  <strong>{{ sig.role }} · {{ sig.signer }}</strong>
                  <code>{{ sig.fingerprint }}</code>
                  <small>{{ formatTime(sig.signedAt) }}</small>
                </div>
              </q-card-section>
            </q-card>
          </q-dialog>
        </section>
      </q-page>
    </q-page-container>
  </q-layout>
</template>
