<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import * as THREE from 'three';
import { useLiftStore } from './store';
import { REVIEW_ROLES, type RoleId } from './authBatch';

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

const reviewRoles = REVIEW_ROLES;

type SignStatus = 'unsigned' | 'valid' | 'invalid';

const statusMeta: Record<SignStatus, { label: string; color: string }> = {
  valid: { label: '签署有效', color: 'positive' },
  invalid: { label: '指纹失配·待重签', color: 'negative' },
  unsigned: { label: '待签署', color: 'grey' }
};

const logKindLabel: Record<string, string> = {
  batch: '批次',
  invalidate: '失效',
  sign: '签署',
  conflict: '并发',
  restore: '恢复',
  lock: '锁定',
  migrate: '迁移'
};

function roleView(roleId: RoleId) {
  return store.signatureView(roleId);
}

function shortFp(fingerprint: string) {
  return fingerprint ? fingerprint.slice(0, 8) : '—';
}

function shortTime(iso: string) {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString('zh-CN', { hour12: false });
}

async function signRole(roleId: RoleId, terminal: string) {
  await store.submitSignature(roleId, terminal);
}

async function raceRole(roleId: RoleId) {
  await store.simulateConcurrentSubmit(roleId);
}

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
            <q-btn color="primary" no-caps icon="lock" :label="store.locked ? '版本已锁定' : '确认并锁定'" :disable="store.locked || store.conflicts.length > 0 || store.openComments.length > 0 || store.validSignatureCount < reviewRoles.length" @click="store.lockPlan" />
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
              <span class="panel-kicker">MULTI-PARTY SIGN-OFF · 授权批次</span>
              <h2>多角色会签与发布门禁</h2>
            </div>
            <div class="readiness"><strong>{{ store.validSignatureCount }}/4</strong><span>有效签署 · 就绪度 {{ store.readiness }}%</span></div>
          </div>

          <div class="batch-banner" :class="{ open: store.authBatch?.status === 'open', locked: store.authBatch?.status === 'locked' }">
            <q-icon :name="store.authBatch?.status === 'locked' ? 'verified' : 'fingerprint'" size="26px" />
            <div class="batch-meta">
              <strong>{{ store.authBatch?.batchNo ?? '尚无授权批次' }}</strong>
              <span v-if="store.authBatch">
                方案 V{{ store.authBatch.planRevision }} · {{ store.authBatch.status === 'locked' ? '批次已锁定归档' : '批次在办' }}
                · 发起于 {{ store.authBatch.openedAt }} · 服务端顺序号 #{{ store.serverSequence }}
              </span>
              <span v-else>发起后将按四位角色的复核范围冻结步骤与评论指纹。</span>
            </div>
            <q-space />
            <q-btn
              outline
              no-caps
              color="primary"
              icon="add_moderator"
              :label="store.authBatch?.status === 'locked' ? `发起 V${store.revision} 新批次` : '重新发起批次'"
              :loading="store.submittingRole !== null"
              @click="store.openAuthBatch"
            />
          </div>

          <q-banner v-if="store.invalidRoles.length" class="invalidate-banner" dense rounded alert>
            <template #avatar><q-icon name="gpp_bad" color="negative" /></template>
            现场步骤或评论已修改：{{ store.invalidRoles.map((id) => reviewRoles.find((r) => r.id === id)?.name).join('、') }}
            的冻结指纹失配，相关签署已作废需重算；范围外角色签署仍然有效。
          </q-banner>

          <q-banner v-if="store.retainedDraft" class="draft-banner" dense rounded alert>
            <template #avatar><q-icon name="save_as" color="primary" /></template>
            晚到终端（{{ store.retainedDraft.terminal }}）的现场内容已保留：
            {{ reviewRoles.find((r) => r.id === store.retainedDraft?.roleId)?.name }}
            复核范围 {{ store.retainedDraft.contentDigest }}（指纹 {{ shortFp(store.retainedDraft.fingerprint) }}，{{ store.retainedDraft.savedAt }}）。
            <template #action>
              <q-btn flat no-caps label="知道了" @click="store.dismissRetainedDraft" />
            </template>
          </q-banner>

          <div class="review-grid">
            <article v-for="person in reviewRoles" :key="person.id" class="review-card" :class="roleView(person.id).status">
              <div class="review-head">
                <strong>{{ person.name }}</strong>
                <q-badge :color="statusMeta[roleView(person.id).status].color">{{ statusMeta[roleView(person.id).status].label }}</q-badge>
              </div>
              <span>{{ person.team }} · 复核 {{ person.stepIds.join('、') }}</span>
              <p>{{ person.scope }}</p>
              <dl class="fp-line">
                <div><dt>冻结指纹</dt><dd :class="{ mismatch: roleView(person.id).status === 'invalid' }">{{ shortFp(roleView(person.id).frozenFingerprint) }}</dd></div>
                <div><dt>现场指纹</dt><dd>{{ shortFp(roleView(person.id).liveFingerprint) }}</dd></div>
                <div v-if="roleView(person.id).signature"><dt>签署</dt><dd>{{ roleView(person.id).signature?.terminal }} · {{ shortTime(roleView(person.id).signature?.signedAt ?? '') }}</dd></div>
              </dl>
              <div class="review-actions">
                <q-btn
                  :color="roleView(person.id).status === 'valid' ? 'positive' : 'primary'"
                  no-caps
                  unelevated
                  :icon="roleView(person.id).status === 'valid' ? 'check_circle' : 'draw'"
                  :label="roleView(person.id).status === 'valid' ? '已签署' : roleView(person.id).status === 'invalid' ? '按新指纹重签' : '接受并签署'"
                  :disable="!store.authBatch || store.authBatch.status === 'locked' || roleView(person.id).status === 'valid'"
                  :loading="store.submittingRole === person.id"
                  @click="signRole(person.id, '终端A')"
                />
                <q-btn
                  outline
                  no-caps
                  icon="devices"
                  label="双终端同时签"
                  :disable="!store.authBatch || store.authBatch.status === 'locked' || store.submittingRole !== null"
                  @click="raceRole(person.id)"
                />
              </div>
            </article>
          </div>

          <div class="review-toolbar">
            <q-btn
              outline
              no-caps
              color="negative"
              icon="storage"
              :label="store.demoDiskFailure ? '下一次签署将模拟写入失败（已挂起）' : '演练：下一次签署写入失败'"
              :disable="store.demoDiskFailure"
              @click="store.armDiskFailure"
            />
            <span class="toolbar-hint">写入失败时事务回滚，本地按批次号恢复，不会留下半份签署。</span>
          </div>

          <div class="review-bottom">
            <section class="auth-log-panel">
              <h3>授权批次日志</h3>
              <ul>
                <li v-for="entry in store.authLogs" :key="entry.id">
                  <q-badge :color="entry.kind === 'invalidate' || entry.kind === 'conflict' ? 'negative' : entry.kind === 'restore' ? 'warning' : 'primary'" class="log-kind">
                    {{ logKindLabel[entry.kind] ?? entry.kind }}
                  </q-badge>
                  <div><p>{{ entry.message }}</p><small>{{ entry.at }}</small></div>
                </li>
                <li v-if="store.authLogs.length === 0" class="empty-state">暂无批次事件。</li>
              </ul>
            </section>

            <section class="version-panel">
              <h3>版本归档 · 旧版本可查</h3>
              <q-expansion-item
                v-for="version in store.versions"
                :key="version.revision + '-' + version.batchNo + '-' + version.source"
                :icon="version.source === 'locked' ? 'lock' : 'history'"
                active-class="text-primary"
              >
                <template #header>
                    <div class="version-line">
                      <strong>V{{ version.revision }}</strong>
                      <q-badge :color="version.source === 'locked' ? 'positive' : 'grey'" dense>
                        {{ version.source === 'locked' ? '锁定发布' : '旧稿迁移' }}
                      </q-badge>
                      <span>{{ version.batchNo }}{{ version.lockedAt ? ' · ' + version.lockedAt : ' · 按当前步骤补指纹' }}</span>
                    </div>
                </template>
                <div class="version-detail">
                  <p v-for="sig in version.signatures" :key="sig.roleId + '-' + sig.signedAt">
                    {{ sig.signer }}（{{ sig.terminal }}）· {{ shortFp(sig.frozenFingerprint) }} · {{ shortTime(sig.signedAt) }}
                  </p>
                  <p v-if="version.signatures.length === 0" class="empty-state">该批次尚无有效签署。</p>
                  <details>
                    <summary>查看 V{{ version.revision }} 步骤快照（{{ version.steps.length }} 步）</summary>
                    <p v-for="step in version.steps" :key="step.id" class="snapshot-step">
                      {{ step.id }} {{ step.title }} · {{ step.loadRate }}% · {{ step.clearance }}m · {{ step.wind }}m/s · {{ step.status }}
                    </p>
                  </details>
                </div>
              </q-expansion-item>
              <div v-if="store.versions.length === 0" class="empty-state">暂无历史版本。</div>
            </section>
          </div>

          <div class="release-gate">
            <div>
              <q-icon name="verified_user" size="30px" />
              <div>
                <strong>发布前门禁</strong>
                <span>要求冲突清零、意见全部关闭、四个角色在当前批次的签署指纹全部有效（{{ store.validSignatureCount }}/4）。</span>
              </div>
            </div>
            <q-btn
              color="primary"
              no-caps
              icon="lock"
              :label="`锁定并发布 V${store.revision + 1}`"
              :disable="store.conflicts.length > 0 || store.openComments.length > 0 || store.validSignatureCount < reviewRoles.length || !store.authBatch || store.authBatch.status === 'locked'"
              @click="store.lockPlan"
            />
          </div>
        </section>
      </q-page>
    </q-page-container>
  </q-layout>
</template>
