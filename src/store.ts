import { defineStore } from 'pinia';
import { graphqlClient, LIFT_PLAN_QUERY, LIFT_PLAN_VERSIONS_QUERY } from './graphql';

export type StepStatus = 'pending' | 'passed' | 'blocked';
export type Comment = {
  id: string;
  author: string;
  role: string;
  content: string;
  status: 'open' | 'resolved';
  stepId: string;
};

export type LiftStep = {
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
};

export type RoleId = 'zongbao' | 'shebei' | 'anquan' | 'fangan';
export type SignatureStatus = 'signed' | 'pending' | 'stale';

export type RoleSignature = {
  role: string;
  signer: string;
  status: SignatureStatus;
  fingerprint: string | null;
  batchId: string | null;
  signedAt: string | null;
  opinion: string;
};

export type AuthBatch = {
  batchId: string;
  planId: string;
  revision: number;
  status: 'open' | 'committed';
  fingerprints: Record<string, string>;
  initiatedAt: string;
};

export type VersionSnapshot = {
  id: string;
  revision: number;
  batchId: string;
  status: string;
  lockedAt: string;
  steps: LiftStep[];
  comments: Comment[];
  signatures: RoleSignature[];
};

export type Notice = { id: number; tone: 'positive' | 'warning' | 'negative' | 'info'; message: string };
export type RecoveryReport = { batchId: string; role: string; action: 'completed' | 'rolled_back'; at: string } | null;

type RoleScope = {
  id: RoleId;
  role: string;
  signer: string;
  team: string;
  scope: string;
  stepFields: (keyof LiftStep)[];
  commentRoles: string[];
};

type WalEntry = {
  batchId: string;
  role: string;
  signer: string;
  fingerprint: string;
  signedAt: string;
  opinion: string;
  status: 'staged' | 'committed';
  stagedAt: string;
};

export const ROLE_SCOPES: RoleScope[] = [
  { id: 'zongbao', role: '总包', signer: '陈晓', team: '总包项目部', scope: '吊装工序与场地移交', stepFields: ['id', 'status', 'note'], commentRoles: ['总包'] },
  { id: 'shebei', role: '设备', signer: '刘明', team: '设备管理', scope: '吊车参数与支腿地基', stepFields: ['id', 'loadRate', 'radius', 'boom'], commentRoles: ['设备'] },
  { id: 'anquan', role: '安全', signer: '周工', team: '安全监督', scope: '净空、风速与警戒区', stepFields: ['id', 'clearance', 'wind'], commentRoles: ['安全'] },
  { id: 'fangan', role: '方案', signer: '赵磊', team: '方案工程', scope: '载荷计算与路径参数', stepFields: ['id', 'loadRate', 'radius', 'boom', 'clearance'], commentRoles: ['方案'] }
];

const initialSteps: LiftStep[] = [
  { id: 'S-01', title: '吊车支腿就位与地耐力复核', time: '07:30', loadRate: 0, clearance: 4.2, wind: 3.4, radius: 18, boom: 42, status: 'passed', note: '支腿钢板 2.4m × 2.4m，已完成压实度复检。' },
  { id: 'S-02', title: '空钩回转与障碍物净空检查', time: '08:10', loadRate: 28, clearance: 1.2, wind: 4.1, radius: 22, boom: 46, status: 'blocked', note: '东侧临时配电箱侵入回转半径 0.6m。' },
  { id: 'S-03', title: '桁架试吊离地 300mm', time: '08:45', loadRate: 76, clearance: 2.8, wind: 5.2, radius: 20, boom: 44, status: 'pending', note: '需安全员确认吊点受力均匀。' },
  { id: 'S-04', title: '主吊回转至安装轴线', time: '09:20', loadRate: 83, clearance: 1.8, wind: 6.8, radius: 24, boom: 48, status: 'pending', note: '风速超过 8m/s 立即停止。' },
  { id: 'S-05', title: '双机抬吊姿态调整', time: '10:05', loadRate: 92, clearance: 1.3, wind: 7.2, radius: 27, boom: 52, status: 'blocked', note: '辅吊荷载率超过方案控制值。' },
  { id: 'S-06', title: '就位、临时固定与摘钩', time: '10:50', loadRate: 68, clearance: 2.1, wind: 5.6, radius: 21, boom: 45, status: 'pending', note: '四组临时螺栓到位后方可摘钩。' }
];

const initialComments: Comment[] = [
  { id: 'C-11', author: '周工', role: '安全', content: 'S-02 回转路径与配电箱净空不足，请调整吊车站位或迁移配电箱。', status: 'open', stepId: 'S-02' },
  { id: 'C-12', author: '刘明', role: '设备', content: '辅吊支腿下方需要补充路基板，提供地耐力实测记录。', status: 'open', stepId: 'S-05' },
  { id: 'C-13', author: '陈晓', role: '总包', content: '同意主吊选型，建议把第三检查点前移到试吊阶段。', status: 'resolved', stepId: 'S-03' }
];

const DRAFT_KEY = 'yy58-lift-plan-draft';
const WAL_KEY = 'yy58-lift-wal';
const PLAN_ID = 'LP-2026-0918';

function readJSON<T>(key: string): T | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

// FNV-1a 32 位稳定指纹：把复核范围内的步骤/评论内容规范化后散列
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function fingerprintFor(role: string, steps: LiftStep[], comments: Comment[]): string {
  const scope = ROLE_SCOPES.find((item) => item.role === role);
  const fields = scope?.stepFields ?? (['id'] as (keyof LiftStep)[]);
  const lines: string[] = [`role:${role}`];
  for (const step of steps) {
    for (const field of fields) {
      lines.push(`step:${step.id}:${String(field)}=${String(step[field])}`);
    }
  }
  for (const comment of comments) {
    if (scope && scope.commentRoles.includes(comment.role)) {
      lines.push(`comment:${comment.id}:${comment.status}:${comment.content}`);
    }
  }
  return fnv1a(lines.join('\n'));
}

function allFingerprints(steps: LiftStep[], comments: Comment[]): Record<string, string> {
  return Object.fromEntries(ROLE_SCOPES.map((scope) => [scope.role, fingerprintFor(scope.role, steps, comments)]));
}

function dateSlug(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

function newBatch(steps: LiftStep[], comments: Comment[], revision: number, migrated: boolean): AuthBatch {
  const suffix = Math.floor(Date.now() / 1000).toString().slice(-4);
  return {
    batchId: migrated ? `BATCH-MIG-${dateSlug()}-${suffix}` : `BATCH-${dateSlug()}-${suffix}`,
    planId: PLAN_ID,
    revision,
    status: 'open',
    fingerprints: allFingerprints(steps, comments),
    initiatedAt: new Date().toISOString()
  };
}

function defaultSignatures(): RoleSignature[] {
  return ROLE_SCOPES.map((scope) => ({ role: scope.role, signer: scope.signer, status: 'pending' as const, fingerprint: null, batchId: null, signedAt: null, opinion: '' }));
}

function normalizeSignatures(saved: unknown): RoleSignature[] {
  const byRole = new Map<string, RoleSignature>();
  if (Array.isArray(saved)) {
    for (const raw of saved) {
      if (!raw || typeof raw !== 'object' || typeof (raw as RoleSignature).role !== 'string') continue;
      const item = raw as Partial<RoleSignature>;
      byRole.set(item.role as string, {
        role: item.role as string,
        signer: typeof item.signer === 'string' ? item.signer : (ROLE_SCOPES.find((s) => s.role === item.role)?.signer ?? '签署人'),
        status: item.status === 'signed' || item.status === 'stale' ? item.status : 'pending',
        fingerprint: typeof item.fingerprint === 'string' ? item.fingerprint : null,
        batchId: typeof item.batchId === 'string' ? item.batchId : null,
        signedAt: typeof item.signedAt === 'string' ? item.signedAt : null,
        opinion: typeof item.opinion === 'string' ? item.opinion : ''
      });
    }
  }
  return ROLE_SCOPES.map((scope) => byRole.get(scope.role) ?? { role: scope.role, signer: scope.signer, status: 'pending' as const, fingerprint: null, batchId: null, signedAt: null, opinion: '' });
}

type DraftShape = {
  steps?: LiftStep[];
  comments?: Comment[];
  selectedStepId?: string;
  revision?: number;
  locked?: boolean;
  viewBookmarks?: string[];
  activeBookmark?: string;
  signatures?: unknown;
  batch?: AuthBatch | null;
  versions?: VersionSnapshot[];
};

const saved = readJSON<DraftShape>(DRAFT_KEY);
const savedWal = readJSON<WalEntry[]>(WAL_KEY) ?? [];

function applyStaged(entry: WalEntry, sig: RoleSignature) {
  sig.status = 'signed';
  sig.signer = entry.signer;
  sig.fingerprint = entry.fingerprint;
  sig.batchId = entry.batchId;
  sig.signedAt = entry.signedAt;
  sig.opinion = entry.opinion;
}

function rollbackSig(sig: RoleSignature, defaultSigner: string) {
  sig.status = 'pending';
  sig.signer = defaultSigner;
  sig.fingerprint = null;
  sig.batchId = null;
  sig.signedAt = null;
  sig.opinion = '';
}

export const useLiftStore = defineStore('lift-plan', {
  state: () => {
    const steps = saved?.steps ?? initialSteps;
    const comments = saved?.comments ?? initialComments;
    const signatures = normalizeSignatures(saved?.signatures);
    let batch: AuthBatch | null = saved?.batch ?? null;
    if (!batch) {
      // 旧草稿缺批次/指纹：按当前步骤补齐复核指纹，历史签署无法核对，置为失效
      batch = newBatch(steps, comments, saved?.revision ?? 4, true);
      for (const sig of signatures) {
        if (sig.status === 'signed') {
          sig.status = 'stale';
          sig.fingerprint = null;
          sig.batchId = null;
          sig.signedAt = null;
        }
      }
    }
    return {
      steps,
      comments,
      selectedStepId: saved?.selectedStepId ?? 'S-02',
      revision: saved?.revision ?? 4,
      locked: saved?.locked ?? false,
      viewBookmarks: saved?.viewBookmarks ?? ['主吊全景', '东侧障碍', '安装轴线'],
      activeBookmark: saved?.activeBookmark ?? '主吊全景',
      signatures,
      batch,
      versions: saved?.versions ?? [],
      wal: savedWal,
      simulateWriteFailure: false,
      lastNotice: null as Notice | null,
      recoveryReport: null as RecoveryReport,
      noticeSeq: 0
    };
  },
  getters: {
    selectedStep(state): LiftStep {
      return state.steps.find((step) => step.id === state.selectedStepId) ?? state.steps[0];
    },
    conflicts(state) {
      return state.steps.flatMap((step) => {
        const issues: string[] = [];
        if (step.loadRate > 90) issues.push(`荷载率 ${step.loadRate}% 超过 90% 阈值`);
        if (step.clearance < 1.5) issues.push(`净空 ${step.clearance}m 小于 1.5m`);
        if (step.wind > 8) issues.push(`风速 ${step.wind}m/s 超过暂停值`);
        if (step.radius > step.boom * 0.62) issues.push('工作半径接近额定幅度');
        return issues.map((message, index) => ({ id: `${step.id}-${index}`, stepId: step.id, title: step.title, message, severity: step.status === 'blocked' ? 'high' : 'medium' }));
      });
    },
    openComments(state) {
      return state.comments.filter((comment) => comment.status === 'open');
    },
    signedCount(state): number {
      return state.signatures.filter((sig) => sig.status === 'signed').length;
    },
    allSigned(state): boolean {
      return state.signatures.every((sig) => sig.status === 'signed');
    },
    readiness(state): number {
      const passedChecks = state.steps.filter((step) => step.status === 'passed').length;
      const commentPenalty = state.comments.filter((item) => item.status === 'open').length * 12;
      const signPenalty = state.signatures.filter((sig) => sig.status !== 'signed').length * 6;
      return Math.max(0, Math.round((passedChecks / state.steps.length) * 100 - commentPenalty - signPenalty));
    }
  },
  actions: {
    notify(tone: Notice['tone'], message: string) {
      this.lastNotice = { id: ++this.noticeSeq, tone, message };
    },
    selectStep(id: string) {
      this.selectedStepId = id;
      this.persist();
    },
    // 发起/重新发起授权批次：按复核范围冻结指纹，签署归属于批次
    initiateReview(silent = false) {
      this.batch = newBatch(this.steps, this.comments, this.revision, false);
      for (const sig of this.signatures) {
        const fp = this.batch.fingerprints[sig.role];
        if (sig.status === 'signed' && sig.fingerprint === fp) {
          sig.batchId = this.batch.batchId;
        } else {
          const scope = ROLE_SCOPES.find((item) => item.role === sig.role);
          rollbackSig(sig, scope?.signer ?? sig.signer);
        }
      }
      this.persist();
      if (!silent) {
        this.notify('info', `已发起授权批次 ${this.batch.batchId}，复核范围指纹已冻结；步骤或评论变更仅使相关角色签署失效，范围外角色不受影响。`);
      }
    },
    // 失效重算：已签署角色的指纹与当前复核范围内容不一致即失效
    refreshSignatures() {
      if (!this.batch || this.batch.status !== 'open') return;
      for (const sig of this.signatures) {
        if (sig.status !== 'signed') continue;
        const fp = fingerprintFor(sig.role, this.steps, this.comments);
        if (fp !== sig.fingerprint) sig.status = 'stale';
      }
    },
    afterContentChange() {
      if (this.locked || !this.batch || this.batch.status !== 'open') {
        const wasLocked = this.locked;
        this.initiateReview(true);
        this.locked = false;
        if (wasLocked) {
          this.notify('warning', '锁定后现场发生变更：已发布版本保留可查，原签署已失效，请按新批次重新签署。');
        }
      } else {
        this.refreshSignatures();
      }
    },
    updateStep(patch: Partial<LiftStep>) {
      const index = this.steps.findIndex((step) => step.id === this.selectedStepId);
      if (index >= 0) this.steps[index] = { ...this.steps[index], ...patch };
      this.afterContentChange();
      this.persist();
    },
    setStatus(status: StepStatus) {
      this.updateStep({ status });
    },
    addComment(content: string, author = '王工', role = '方案') {
      if (!content.trim()) return;
      this.comments.unshift({ id: `C-${Date.now()}`, author, role, content, status: 'open', stepId: this.selectedStepId });
      this.afterContentChange();
      this.persist();
    },
    resolveComment(id: string) {
      const item = this.comments.find((comment) => comment.id === id);
      if (item) item.status = 'resolved';
      this.afterContentChange();
      this.persist();
    },
    // 角色签署：WAL 暂存 → 阶段提交；并发先到生效；失败按批次号恢复，不留半份签署
    async signRole(role: string, opinion = '', signerOverride?: string, delayMs = 0, silent = false): Promise<{ ok: boolean; conflict: boolean }> {
      if (!this.batch || this.batch.status !== 'open') this.initiateReview();
      const sig = this.signatures.find((item) => item.role === role);
      if (!sig) return { ok: false, conflict: false };
      const scope = ROLE_SCOPES.find((item) => item.role === role);
      const signer = signerOverride ?? scope?.signer ?? sig.signer;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      // 提交前复核批次状态：另一终端先签署则本终端晚到，先到生效、现场内容保留
      if (!this.batch || this.batch.status !== 'open') {
        if (!silent) this.notify('warning', `签署未生效：授权批次已关闭，现场内容已保留。`);
        return { ok: false, conflict: true };
      }
      if (sig.status === 'signed') {
        if (!silent) this.notify('warning', `签署未生效：${role} 角色已由其他终端签署（先到生效），现场内容已保留。`);
        return { ok: false, conflict: true };
      }
      const entry: WalEntry = {
        batchId: this.batch.batchId,
        role,
        signer,
        fingerprint: fingerprintFor(role, this.steps, this.comments),
        signedAt: new Date().toISOString(),
        opinion: opinion.trim(),
        status: 'staged',
        stagedAt: new Date().toISOString()
      };
      this.wal.push(entry);
      this.persistWal();
      try {
        // 阶段提交 1：先写入指纹与批次；此后中断会留下半份签署
        sig.fingerprint = entry.fingerprint;
        sig.batchId = entry.batchId;
        this.persist();
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (this.simulateWriteFailure) throw new Error('模拟写入故障：提交在指纹写入后中断');
        // 阶段提交 2：翻转状态并写入时间戳，签署完成
        sig.status = 'signed';
        sig.signer = signer;
        sig.signedAt = entry.signedAt;
        sig.opinion = entry.opinion;
        this.persist();
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (this.simulateWriteFailure) throw new Error('模拟写入故障：提交在状态翻转后中断');
        entry.status = 'committed';
        this.persistWal();
        if (!silent) this.notify('positive', `${role} 签署已生效（批次 ${entry.batchId}，指纹 ${entry.fingerprint}）。`);
        return { ok: true, conflict: false };
      } catch {
        const report = this.recoverByBatch(entry.batchId, role);
        const done = report?.action === 'completed';
        if (!silent) {
          this.notify('negative', `写入失败，已按批次号 ${entry.batchId} 恢复：${done ? '签署已补全' : '已回滚'}，无半份签署残留，请确认后重新签署。`);
        }
        return { ok: false, conflict: false };
      }
    },
    // 按批次号恢复：整份补全或回滚，保证不留下半份签署
    recoverByBatch(batchId: string, role?: string): RecoveryReport {
      const entries = this.wal.filter((entry) => entry.status === 'staged' && entry.batchId === batchId && (!role || entry.role === role));
      let report: RecoveryReport = this.recoveryReport;
      for (const entry of entries) {
        const sig = this.signatures.find((item) => item.role === entry.role);
        const scope = ROLE_SCOPES.find((item) => item.role === entry.role);
        const currentFp = fingerprintFor(entry.role, this.steps, this.comments);
        const batchOpen = this.batch?.batchId === batchId && this.batch.status === 'open';
        const whole =
          !!sig &&
          sig.status === 'signed' &&
          sig.fingerprint === entry.fingerprint &&
          sig.batchId === entry.batchId &&
          sig.signedAt === entry.signedAt;
        if (batchOpen && currentFp === entry.fingerprint) {
          if (sig && !whole) applyStaged(entry, sig);
          entry.status = 'committed';
          report = { batchId, role: entry.role, action: 'completed', at: new Date().toISOString() };
        } else {
          if (sig) rollbackSig(sig, scope?.signer ?? sig.signer);
          this.wal = this.wal.filter((item) => item !== entry);
          report = { batchId, role: entry.role, action: 'rolled_back', at: new Date().toISOString() };
        }
      }
      this.persist();
      this.persistWal();
      if (report) this.recoveryReport = report;
      return report;
    },
    // 启动时恢复所有未完成写入
    recoverAll() {
      const staged = this.wal.filter((entry) => entry.status === 'staged');
      if (staged.length === 0) return;
      let completed = 0;
      let rolledBack = 0;
      for (const entry of staged) {
        const sig = this.signatures.find((item) => item.role === entry.role);
        const scope = ROLE_SCOPES.find((item) => item.role === entry.role);
        const currentFp = fingerprintFor(entry.role, this.steps, this.comments);
        const batchOpen = this.batch?.batchId === entry.batchId && this.batch.status === 'open';
        const whole =
          !!sig &&
          sig.status === 'signed' &&
          sig.fingerprint === entry.fingerprint &&
          sig.batchId === entry.batchId &&
          sig.signedAt === entry.signedAt;
        if (batchOpen && currentFp === entry.fingerprint) {
          if (sig && !whole) applyStaged(entry, sig);
          entry.status = 'committed';
          completed += 1;
        } else {
          if (sig) rollbackSig(sig, scope?.signer ?? sig.signer);
          rolledBack += 1;
        }
      }
      this.wal = this.wal.filter((entry) => entry.status !== 'staged');
      this.persist();
      this.persistWal();
      this.notify('info', `检测到 ${staged.length} 笔未完成签署写入，已按批次号恢复：补全 ${completed} 笔、回滚 ${rolledBack} 笔，无半份签署残留。`);
    },
    // 模拟两个终端同时提交同一角色签署：先到生效，晚到保留现场内容
    async simulateConcurrentSign(role: string) {
      if (!this.batch || this.batch.status !== 'open') this.initiateReview();
      const scope = ROLE_SCOPES.find((item) => item.role === role);
      const [ra, rb] = await Promise.all([
        this.signRole(role, `终端A：同意按当前参数施工（${scope?.signer ?? role}）`, scope?.signer ?? role, 10, true),
        this.signRole(role, '终端B：现场复核后同意，保留本终端意见', '现场终端-王工', 60, true)
      ]);
      const firstOk = ra.ok;
      this.notify(
        firstOk && !rb.ok ? 'positive' : 'warning',
        `并发签署结果：终端A ${firstOk ? '先到生效' : '未生效'}；终端B ${rb.ok ? '生效' : '晚到未生效'}。同角色签署以先到为准，现场内容保留未被覆盖。`
      );
    },
    lockPlan() {
      if (this.conflicts.length > 0 || this.openComments.length > 0) {
        this.notify('warning', '存在冲突或未关闭意见，无法锁定发布。');
        return;
      }
      if (!this.signatures.every((sig) => sig.status === 'signed')) {
        this.notify('warning', '四个角色未全部完成签署，无法锁定发布。');
        return;
      }
      if (!this.batch) this.initiateReview(true);
      const snapshot: VersionSnapshot = {
        id: `V${this.revision + 1}`,
        revision: this.revision + 1,
        batchId: this.batch.batchId,
        status: 'LOCKED',
        lockedAt: new Date().toISOString(),
        steps: JSON.parse(JSON.stringify(this.steps)) as LiftStep[],
        comments: JSON.parse(JSON.stringify(this.comments)) as Comment[],
        signatures: JSON.parse(JSON.stringify(this.signatures)) as RoleSignature[]
      };
      this.versions.unshift(snapshot);
      this.batch.status = 'committed';
      graphqlClient.writeQuery({
        query: LIFT_PLAN_QUERY,
        variables: { id: PLAN_ID },
        data: {
          liftPlan: {
            __typename: 'LiftPlan',
            id: PLAN_ID,
            name: '东塔转换桁架吊装',
            revision: this.revision + 1,
            status: 'LOCKED',
            steps: this.steps.map((step) => ({ __typename: 'LiftStep', id: step.id, name: step.title, loadRate: step.loadRate, clearance: step.clearance }))
          }
        }
      });
      graphqlClient.writeQuery({
        query: LIFT_PLAN_VERSIONS_QUERY,
        variables: { planId: PLAN_ID },
        data: {
          liftPlanVersions: this.versions.map((version) => ({
            __typename: 'LiftPlanVersion',
            id: version.id,
            revision: version.revision,
            batchId: version.batchId,
            status: version.status,
            lockedAt: version.lockedAt
          }))
        }
      });
      this.revision += 1;
      this.locked = true;
      this.persist();
      this.notify('positive', `方案已锁定发布为 V${this.revision}（批次 ${snapshot.batchId}），历史版本继续可查。`);
    },
    setBookmark(name: string) {
      this.activeBookmark = name;
      if (!this.viewBookmarks.includes(name)) this.viewBookmarks.push(name);
      this.persist();
    },
    persist() {
      if (typeof localStorage === 'undefined') return;
      const data = {
        steps: this.steps,
        comments: this.comments,
        selectedStepId: this.selectedStepId,
        revision: this.revision,
        locked: this.locked,
        viewBookmarks: this.viewBookmarks,
        activeBookmark: this.activeBookmark,
        signatures: this.signatures,
        batch: this.batch,
        versions: this.versions,
        draftSavedAt: new Date().toISOString()
      };
      localStorage.setItem(DRAFT_KEY, JSON.stringify(data));
    },
    persistWal() {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(WAL_KEY, JSON.stringify(this.wal));
    }
  }
});
