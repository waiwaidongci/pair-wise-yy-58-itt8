import { defineStore } from 'pinia';
import { graphqlClient, LIFT_PLAN_QUERY } from './graphql';
import {
  REVIEW_ROLES,
  roleFingerprint,
  rolesCoveringStep,
  rolesCoveringComment,
  signingServer,
  type AuthBatch,
  type RoleId,
  type RoleSignature,
  type ServerSnapshot
} from './authBatch';

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

export type AuthLogEntry = {
  id: string;
  at: string;
  kind: 'batch' | 'invalidate' | 'sign' | 'conflict' | 'restore' | 'lock' | 'migrate';
  message: string;
};

export type RetainedDraft = {
  roleId: RoleId;
  terminal: string;
  fingerprint: string;
  contentDigest: string;
  savedAt: string;
};

export type PlanVersion = {
  revision: number;
  batchNo: string;
  lockedAt: string;
  source: 'locked' | 'migrated';
  steps: LiftStep[];
  signatures: RoleSignature[];
};

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

const cacheKey = 'yy58-lift-plan-draft';
const SCHEMA_VERSION = 2;
const PLAN_ID = 'LP-2026-0918';
const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(cacheKey) : null;
const saved = stored ? (JSON.parse(stored) as Record<string, unknown>) : null;

function nowText(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 旧草稿迁移：缺批次/指纹时，按当前步骤与评论为四位角色补齐冻结指纹，
 * 开一个与当前版本对应的授权批次；旧版本快照保留可查。
 */
function migrate(savedDraft: Record<string, unknown> | null) {
  const steps = (savedDraft?.steps as LiftStep[]) ?? clone(initialSteps);
  const comments = (savedDraft?.comments as Comment[]) ?? clone(initialComments);
  const revision = (savedDraft?.revision as number) ?? 4;

  const logs: AuthLogEntry[] = [];
  let versions: PlanVersion[] = [];
  let authBatch: AuthBatch | null = (savedDraft?.authBatch as AuthBatch) ?? null;
  let signatures: RoleSignature[] = (savedDraft?.signatures as RoleSignature[]) ?? [];

  const isLegacyDraft = savedDraft !== null && (savedDraft.schemaVersion !== SCHEMA_VERSION || !savedDraft.authBatch);
  if (isLegacyDraft || !savedDraft) {
    // 旧草稿缺指纹：按当前步骤为各角色补齐冻结指纹，作为在办批次基线
    authBatch = {
      batchNo: `AUTH-V${revision}-001`,
      planRevision: revision,
      openedAt: nowText(),
      status: 'open'
    };
    signatures = signatures
      .filter((item) => item.batchNo === authBatch?.batchNo)
      .map((item) => ({ ...item, frozenFingerprint: roleFingerprint(item.roleId, steps, comments) }));
    versions = [
      {
        revision,
        batchNo: authBatch.batchNo,
        lockedAt: '',
        source: 'migrated',
        steps: clone(steps),
        signatures: clone(signatures)
      }
    ];
    signingServer.bootstrap({ sequence: 1, batch: clone(authBatch), signatures: clone(signatures) });
    logs.push({ id: `L-${Date.now()}`, at: nowText(), kind: 'migrate', message: `旧草稿缺少指纹，已按当前步骤为 V${revision} 补齐四角色复核指纹（${authBatch.batchNo}），历史版本保留可查。` });
  } else {
    versions = (savedDraft.versions as PlanVersion[]) ?? [];
    const snapshot = signingServer.getSnapshot();
    if (snapshot.batch?.batchNo !== authBatch?.batchNo) {
      signingServer.bootstrap({
        sequence: (savedDraft.serverSequence as number) ?? 0,
        batch: clone(authBatch),
        signatures: clone(signatures)
      });
    }
  }

  return {
    steps,
    comments,
    selectedStepId: (savedDraft?.selectedStepId as string) ?? 'S-02',
    revision,
    locked: (savedDraft?.locked as boolean) ?? false,
    viewBookmarks: (savedDraft?.viewBookmarks as string[]) ?? ['主吊全景', '东侧障碍', '安装轴线'],
    activeBookmark: (savedDraft?.activeBookmark as string) ?? '主吊全景',
    authBatch,
    signatures,
    serverSequence: isLegacyDraft || !savedDraft ? 1 : ((savedDraft?.serverSequence as number) ?? 0),
    authLogs: [...logs, ...(((savedDraft?.authLogs as AuthLogEntry[]) ?? []))],
    retainedDraft: (savedDraft?.retainedDraft as RetainedDraft | null) ?? null,
    versions,
    submittingRole: null as RoleId | null,
    demoDiskFailure: false
  };
}

const migrated = migrate(saved);

export const useLiftStore = defineStore('lift-plan', {
  state: () => ({
    steps: migrated.steps,
    comments: migrated.comments,
    selectedStepId: migrated.selectedStepId,
    revision: migrated.revision,
    locked: migrated.locked,
    viewBookmarks: migrated.viewBookmarks,
    activeBookmark: migrated.activeBookmark,
    authBatch: migrated.authBatch as AuthBatch | null,
    signatures: migrated.signatures as RoleSignature[],
    serverSequence: migrated.serverSequence,
    authLogs: migrated.authLogs as AuthLogEntry[],
    retainedDraft: migrated.retainedDraft as RetainedDraft | null,
    versions: migrated.versions as PlanVersion[],
    submittingRole: migrated.submittingRole as RoleId | null,
    demoDiskFailure: migrated.demoDiskFailure
  }),
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
    readiness(state): number {
      const passedChecks = state.steps.filter((step) => step.status === 'passed').length;
      const commentPenalty = state.comments.filter((item) => item.status === 'open').length * 12;
      return Math.max(0, Math.round((passedChecks / state.steps.length) * 100 - commentPenalty));
    },
    /** 角色签署视图：冻结指纹 vs 当前现场指纹，决定有效/失效/未签 */
    signatureView(state) {
      return (roleId: RoleId) => {
        const liveFingerprint = roleFingerprint(roleId, state.steps, state.comments);
        const inBatch = state.signatures.find(
          (item) => item.roleId === roleId && state.authBatch !== null && item.batchNo === state.authBatch.batchNo
        );
        let status: 'unsigned' | 'valid' | 'invalid';
        if (!inBatch) status = 'unsigned';
        else if (inBatch.frozenFingerprint === liveFingerprint) status = 'valid';
        else status = 'invalid';
        return {
          status,
          liveFingerprint,
          signature: inBatch ?? null,
          frozenFingerprint: inBatch?.frozenFingerprint ?? liveFingerprint
        };
      };
    },
    validSignatures(state): RoleSignature[] {
      if (!state.authBatch) return [];
      return REVIEW_ROLES.map((role) => {
        const item = state.signatures.find((sig) => sig.roleId === role.id && sig.batchNo === state.authBatch?.batchNo);
        if (!item) return null;
        return item.frozenFingerprint === roleFingerprint(role.id, state.steps, state.comments) ? item : null;
      }).filter((item): item is RoleSignature => item !== null);
    },
    validSignatureCount(): number {
      return this.validSignatures.length;
    },
    invalidRoles(): RoleId[] {
      return REVIEW_ROLES.filter((role) => this.signatureView(role.id).status === 'invalid').map((role) => role.id);
    }
  },
  actions: {
    selectStep(id: string) {
      this.selectedStepId = id;
      this.persist();
    },
    updateStep(patch: Partial<LiftStep>) {
      const index = this.steps.findIndex((step) => step.id === this.selectedStepId);
      if (index >= 0) this.steps[index] = { ...this.steps[index], ...patch };
      // 步骤一改：冻结指纹不再匹配，相关角色签署失效重算；范围外角色不受影响
      this.invalidateByScope(rolesCoveringStep(this.selectedStepId), `步骤 ${this.selectedStepId} 现场参数已修改`);
      this.persist();
    },
    setStatus(status: StepStatus) {
      this.updateStep({ status });
    },
    addComment(content: string, author = '王工', role = '方案') {
      if (!content.trim()) return;
      const comment: Comment = { id: `C-${Date.now()}`, author, role, content, status: 'open', stepId: this.selectedStepId };
      this.comments.unshift(comment);
      // 评论同样纳入指纹：新增/变更只作废评论所属步骤的复核角色
      this.invalidateByScope(rolesCoveringComment(comment), `步骤 ${this.selectedStepId} 新增条件评论`);
      this.persist();
    },
    resolveComment(id: string) {
      const item = this.comments.find((comment) => comment.id === id);
      if (item) {
        item.status = 'resolved';
        this.invalidateByScope(rolesCoveringComment(item), `步骤 ${item.stepId} 评论「${id}」已关闭`);
      }
      this.persist();
    },

    /** 发起授权批次：按各角色复核范围冻结指纹（乐观锁写入服务端） */
    async openAuthBatch() {
      const currentSeq = this.authBatch ? Number(this.authBatch.batchNo.slice(-3)) : 0;
      const batchNo = `AUTH-V${this.revision}-${String(currentSeq + 1).padStart(3, '0')}`;
      const batch: AuthBatch = { batchNo, planRevision: this.revision, openedAt: nowText(), status: 'open' };
      const expectedSequence = this.serverSequence;
      const outcome = await signingServer.openBatch(batch, expectedSequence, []);
      if (outcome.ok) {
        this.applySnapshot(outcome.snapshot);
        this.retainedDraft = null;
        this.pushLog('batch', `授权批次 ${batchNo} 已发起，按复核范围冻结四角色指纹（方案 V${this.revision}）。`);
      } else {
        this.restoreSnapshot(outcome.snapshot, '批次发起冲突，已按服务端批次号恢复');
      }
      this.persist();
    },

    /**
     * 提交角色签署：
     *  - 冻结指纹取当前现场内容（重算）；
     *  - 乐观更新后整批原子提交服务端；
     *  - 写入失败按批次号恢复快照，不保留本地半份签署；
     *  - role-taken 表示同角色已有先到签署，晚到终端的现场内容单独保留。
     */
    async submitSignature(roleId: RoleId, terminal = '终端A') {
      if (!this.authBatch || this.submittingRole) return;
      const role = REVIEW_ROLES.find((item) => item.id === roleId);
      if (!role) return;

      if (this.demoDiskFailure) {
        signingServer.armNextSubmit('disk');
        this.demoDiskFailure = false;
      }

      const batchNo = this.authBatch.batchNo;
      const candidate: RoleSignature = {
        roleId,
        signer: role.name,
        batchNo,
        frozenFingerprint: roleFingerprint(roleId, this.steps, this.comments),
        signedAt: new Date().toISOString(),
        terminal
      };

      // 乐观落本地，整批一起提交（原子单位 = 整批签署）
      const expectedSequence = this.serverSequence;
      const others = this.signatures.filter((item) => !(item.roleId === roleId && item.batchNo === batchNo));
      this.signatures = [...others, candidate];
      this.submittingRole = roleId;
      this.persist();

      const outcome = await signingServer.submit(batchNo, expectedSequence, clone(this.signatures));
      this.submittingRole = null;

      if (outcome.ok) {
        this.applySnapshot(outcome.snapshot);
        this.pushLog('sign', `${role.name}（${role.team}）在 ${terminal} 完成签署，指纹 ${candidate.frozenFingerprint.slice(0, 8)} 已冻结。`);
      } else if (outcome.reason === 'role-taken' && outcome.conflictRole) {
        // 先到生效：恢复服务端签署；晚到终端保留现场内容，不覆盖现场
        this.restoreSnapshot(outcome.snapshot, `${terminal} 的 ${role.name} 签署晚到：同角色签署已由先到终端生效，本终端按批次号恢复，未留下半份签署。`);
        this.retainedDraft = {
          roleId,
          terminal,
          fingerprint: candidate.frozenFingerprint,
          contentDigest: this.scopeDigest(roleId),
          savedAt: nowText()
        };
        this.pushLog('conflict', `${terminal} 晚到被拒，${role.name} 的现场内容已保留为草稿（指纹 ${candidate.frozenFingerprint.slice(0, 8)}）。`);
      } else {
        this.restoreSnapshot(outcome.snapshot, `${terminal} 的 ${role.name} 签署写入失败：事务已回滚，按批次号 ${batchNo} 恢复，无半份签署残留。`);
      }
      this.persist();
    },

    /**
     * 两个终端同时提交同一角色：基于同一顺序号并发，先到生效、晚到保留现场内容。
     */
    async simulateConcurrentSubmit(roleId: RoleId) {
      if (!this.authBatch || this.submittingRole) return;
      await this.openBatchIfNeeded();
      if (!this.authBatch) return;
      const role = REVIEW_ROLES.find((item) => item.id === roleId);
      if (!role) return;

      const batchNo = this.authBatch.batchNo;
      const expectedSequence = this.serverSequence;
      const liveFingerprint = roleFingerprint(roleId, this.steps, this.comments);
      const stamp = (tag: string) => new Date(Date.now() + (tag === 'B' ? 1 : 0)).toISOString();
      const makeSignature = (terminal: string) => {
        const tag = terminal.slice(-1);
        return { roleId, signer: role.name, batchNo, frozenFingerprint: liveFingerprint, signedAt: stamp(tag), terminal } as RoleSignature;
      };
      const base = this.signatures.filter((item) => !(item.roleId === roleId && item.batchNo === batchNo));
      const payloadA = [...base, makeSignature('终端A')];
      const payloadB = [...base, makeSignature('终端B')];

      this.submittingRole = roleId;
      this.pushLog('sign', `两个终端同时提交 ${role.name} 的签署（批次 ${batchNo}，同一顺序号 ${expectedSequence}）…`);

      const [resultA, resultB] = await Promise.all([
        signingServer.submit(batchNo, expectedSequence, clone(payloadA)),
        signingServer.submit(batchNo, expectedSequence, clone(payloadB))
      ]);

      this.submittingRole = null;
      const winner = resultA.ok ? resultA : resultB.ok ? resultB : null;
      if (winner) {
        const winnerTerminal = resultA.ok ? '终端A' : '终端B';
        this.applySnapshot(winner.snapshot);
        this.pushLog('sign', `${winnerTerminal} 先到，${role.name} 签署生效。`);
        const loser = resultA.ok ? resultB : resultA;
        const loserTerminal = resultA.ok ? '终端B' : '终端A';
        if (!loser.ok && loser.reason === 'role-taken') {
          this.retainedDraft = {
            roleId,
            terminal: loserTerminal,
            fingerprint: liveFingerprint,
            contentDigest: this.scopeDigest(roleId),
            savedAt: nowText()
          };
          this.pushLog('conflict', `${loserTerminal} 晚到被拒：现场内容已原样保留，可核对后再重签，不会覆盖先到签署。`);
        }
      } else {
        this.restoreSnapshot(resultB.snapshot, '双终端提交均写入失败，已按批次号恢复。');
      }
      this.persist();
    },

    armDiskFailure() {
      this.demoDiskFailure = true;
      this.persist();
    },

    dismissRetainedDraft() {
      this.retainedDraft = null;
      this.persist();
    },

    async lockPlan() {
      if (this.conflicts.length > 0 || this.openComments.length > 0 || this.validSignatureCount < REVIEW_ROLES.length || !this.authBatch) {
        this.persist();
        return;
      }
      const snapshot = signingServer.lockBatch();
      this.applySnapshot(snapshot);
      this.locked = true;
      this.revision += 1;

      // 旧版本继续可查：归档锁定时的步骤、指纹与签署
      this.versions.unshift({
        revision: this.revision,
        batchNo: this.authBatch.batchNo,
        lockedAt: nowText(),
        source: 'locked',
        steps: clone(this.steps),
        signatures: clone(this.validSignatures)
      });

      graphqlClient.writeQuery({
        query: LIFT_PLAN_QUERY,
        variables: { id: PLAN_ID },
        data: { liftPlan: { __typename: 'LiftPlan', id: PLAN_ID, name: '东塔转换桁架吊装', revision: this.revision, status: 'LOCKED', steps: this.steps } }
      });
      this.pushLog('lock', `方案 V${this.revision} 已锁定发布（批次 ${this.authBatch.batchNo}，四角色签署指纹全部有效）。`);
      this.persist();
    },

    setBookmark(name: string) {
      this.activeBookmark = name;
      if (!this.viewBookmarks.includes(name)) this.viewBookmarks.push(name);
      this.persist();
    },

    /* ---------------- 内部机制 ---------------- */

    async openBatchIfNeeded() {
      if (!this.authBatch || this.authBatch.status === 'locked') {
        await this.openAuthBatch();
      }
    },

    invalidateByScope(roleIds: RoleId[], detail: string) {
      if (!this.authBatch) return;
      const batchNo = this.authBatch.batchNo;
      const invalidated = roleIds.filter((roleId) => {
        const signature = this.signatures.find((item) => item.roleId === roleId && item.batchNo === batchNo);
        return signature !== undefined && signature.frozenFingerprint !== roleFingerprint(roleId, this.steps, this.comments);
      });
      if (invalidated.length === 0) return;
      const names = invalidated.map((id) => REVIEW_ROLES.find((role) => role.id === id)?.name).join('、');
      // 范围外角色不在 invalidated 中，签署继续有效
      this.pushLog('invalidate', `${detail}：${names} 的冻结指纹失配，签署已作废，需按当前现场内容重算重签。`);
    },

    scopeDigest(roleId: RoleId): string {
      const role = REVIEW_ROLES.find((item) => item.id === roleId);
      if (!role) return '';
      const steps = this.steps.filter((step) => role.stepIds.includes(step.id));
      return steps.map((step) => `${step.id}@${step.loadRate}%/${step.clearance}m/${step.wind}m·s⁻¹/${step.status}`).join('；');
    },

    applySnapshot(snapshot: ServerSnapshot) {
      this.serverSequence = snapshot.sequence;
      this.authBatch = snapshot.batch ? clone(snapshot.batch) : null;
      this.signatures = clone(snapshot.signatures);
    },

    restoreSnapshot(snapshot: ServerSnapshot, reason: string) {
      // 写入失败后的恢复路径：以服务端批次号为准整体回滚
      this.applySnapshot(snapshot);
      this.pushLog('restore', `${reason}（恢复到顺序号 ${snapshot.sequence}）。`);
    },

    pushLog(kind: AuthLogEntry['kind'], message: string) {
      this.authLogs.unshift({ id: `L-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, at: nowText(), kind, message });
      if (this.authLogs.length > 40) this.authLogs.length = 40;
    },

    persist() {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(
          cacheKey,
          JSON.stringify({ ...this.$state, schemaVersion: SCHEMA_VERSION, draftSavedAt: new Date().toISOString() })
        );
      }
    }
  }
});
