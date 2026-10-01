import type { Comment, LiftStep } from './store';

/**
 * 授权批次（Authorization Batch）
 *
 * 把吊装步骤、条件评论、四位角色的签署与方案版本接在同一个批次里：
 *  - 发起批次时按每个角色的复核范围冻结指纹（scope fingerprint）；
 *  - 范围内步骤或评论一改，该角色签署的现场指纹与冻结指纹不符，签署即作废、需重算重签；
 *  - 范围外角色不受牵连；
 *  - 签署写入由（模拟）会签服务端按批次号 + 乐观锁顺序号原子落账，
 *    同角色双终端并发时先到生效，晚到被拒并保留现场内容；
 *  - 写入失败整体回滚，本地按批次号恢复，不会留下半份签署。
 */

export type RoleId = 'general' | 'equipment' | 'safety' | 'planner';

export type ReviewRole = {
  id: RoleId;
  name: string;
  team: string;
  scope: string;
  /** 该角色复核范围内的步骤；未列入的步骤改动不影响其签署 */
  stepIds: string[];
};

export const REVIEW_ROLES: ReviewRole[] = [
  { id: 'general', name: '陈晓', team: '总包项目部', scope: '吊装工序与场地移交', stepIds: ['S-01', 'S-06'] },
  { id: 'equipment', name: '刘明', team: '设备管理', scope: '吊车参数与支腿地基', stepIds: ['S-01', 'S-05'] },
  { id: 'safety', name: '周工', team: '安全监督', scope: '净空、风速与警戒区', stepIds: ['S-02', 'S-03', 'S-04'] },
  { id: 'planner', name: '赵磊', team: '方案工程', scope: '载荷计算与路径参数', stepIds: ['S-03', 'S-04', 'S-05'] }
];

/* ------------------------------------------------------------------ */
/* 指纹：对复核范围内的步骤与相关评论做确定性哈希                        */
/* ------------------------------------------------------------------ */

const STEP_FIELDS: (keyof LiftStep)[] = ['time', 'loadRate', 'clearance', 'wind', 'radius', 'boom', 'status', 'note'];

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** cyrb53：无第三方依赖的确定性哈希，输出 16 位十六进制指纹 */
function cyrb53(input: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const h = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return h.toString(16).padStart(16, '0');
}

function stepsFingerprint(role: ReviewRole, steps: LiftStep[]): string {
  const scoped = steps
    .filter((step) => role.stepIds.includes(step.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((step) => {
      const picked: Record<string, unknown> = { id: step.id };
      STEP_FIELDS.forEach((field) => {
        picked[field] = step[field];
      });
      return picked;
    });
  return cyrb53(canonicalize(scoped), 0x517a);
}

function commentsFingerprint(role: ReviewRole, comments: Comment[]): string {
  const scoped = comments
    .filter((comment) => role.stepIds.includes(comment.stepId))
    .map((comment) => ({ id: comment.id, content: comment.content, status: comment.status }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return cyrb53(canonicalize(scoped), 0xc0ee);
}

/** 角色级冻结指纹：范围内步骤 + 范围内评论 */
export function roleFingerprint(roleId: RoleId, steps: LiftStep[], comments: Comment[]): string {
  const role = REVIEW_ROLES.find((item) => item.id === roleId);
  if (!role) return '';
  return `${stepsFingerprint(role, steps).slice(0, 10)}-${commentsFingerprint(role, comments).slice(0, 10)}`;
}

/** 步骤改动会牵连哪些角色（范围外角色不跟着作废） */
export function rolesCoveringStep(stepId: string): RoleId[] {
  return REVIEW_ROLES.filter((role) => role.stepIds.includes(stepId)).map((role) => role.id);
}

/** 评论改动按其所属步骤牵连角色 */
export function rolesCoveringComment(comment: Pick<Comment, 'stepId'>): RoleId[] {
  return rolesCoveringStep(comment.stepId);
}

/* ------------------------------------------------------------------ */
/* 模拟会签服务端：批次号 + 乐观锁，原子写入，先到先得                   */
/* ------------------------------------------------------------------ */

export type RoleSignature = {
  roleId: RoleId;
  signer: string;
  batchNo: string;
  /** 发起批次（或上次重签）时按复核范围冻结的指纹 */
  frozenFingerprint: string;
  signedAt: string;
  terminal: string;
};

export type AuthBatch = {
  batchNo: string;
  planRevision: number;
  openedAt: string;
  status: 'open' | 'locked';
};

export type ServerSnapshot = {
  sequence: number;
  batch: AuthBatch | null;
  signatures: RoleSignature[];
};

export type SubmitOutcome =
  | { ok: true; snapshot: ServerSnapshot }
  | { ok: false; reason: 'stale-batch' | 'role-taken'; conflictRole?: RoleId; snapshot: ServerSnapshot };

type PendingFailure = null | 'conflict' | 'stale-batch' | 'disk';

const LATENCY_MS = 260;

export class SigningServer {
  private sequence = 0;
  private batch: AuthBatch | null = null;
  private signatures: RoleSignature[] = [];
  private pendingFailure: PendingFailure = null;

  /** 旧草稿迁移 / 页面重载：把服务端恢复到持久化的批次快照 */
  bootstrap(snapshot: ServerSnapshot) {
    this.sequence = snapshot.sequence;
    this.batch = snapshot.batch ? { ...snapshot.batch } : null;
    this.signatures = snapshot.signatures.map((item) => ({ ...item }));
    this.pendingFailure = null;
  }

  /** 下一次提交的结果（只生效一次），用于演示双终端抢占与写入失败 */
  armNextSubmit(outcome: PendingFailure) {
    this.pendingFailure = outcome;
  }

  getSnapshot(): ServerSnapshot {
    return {
      sequence: this.sequence,
      batch: this.batch ? { ...this.batch } : null,
      signatures: this.signatures.map((item) => ({ ...item }))
    };
  }

  /** 发起授权批次：批次号乐观锁，重复发起同一批次号为幂等操作 */
  openBatch(next: AuthBatch, expectedSequence: number, baseSignatures: RoleSignature[]): Promise<SubmitOutcome> {
    return this.deliver(() => {
      if (expectedSequence !== this.sequence) return { ok: false as const, reason: 'stale-batch', snapshot: this.snapshot() };
      if (!this.batch || this.batch.batchNo !== next.batchNo) {
        this.batch = { ...next };
        this.signatures = baseSignatures.map((item) => ({ ...item }));
        this.sequence += 1;
      }
      return { ok: true as const, snapshot: this.snapshot() };
    });
  }

  /**
   * 原子提交整批签署：任何一项不满足，整批拒写、服务端状态不变，
   * 客户端拿到快照按批次号恢复 —— 不存在“写进去一半”的签署。
   */
  submit(batchNo: string, expectedSequence: number, nextSignatures: RoleSignature[]): Promise<SubmitOutcome> {
    return this.deliver(() => {
      const armed = this.pendingFailure;
      this.pendingFailure = null;
      if (armed === 'disk') {
        // 磁盘故障：事务回滚，服务端保持原状态
        return { ok: false as const, reason: 'stale-batch' as const, snapshot: this.snapshot() };
      }
      if (!this.batch || this.batch.batchNo !== batchNo) {
        return { ok: false as const, reason: 'stale-batch', snapshot: this.snapshot() };
      }
      if (expectedSequence !== this.sequence) {
        const conflictRole = this.findConflictRole(nextSignatures);
        return {
          ok: false as const,
          reason: conflictRole ? 'role-taken' : 'stale-batch',
          conflictRole,
          snapshot: this.snapshot()
        };
      }
      if (armed === 'stale-batch') {
        return { ok: false as const, reason: 'stale-batch', snapshot: this.snapshot() };
      }
      const conflict = this.findConflictRole(nextSignatures);
      if (conflict) {
        return { ok: false as const, reason: 'role-taken', conflictRole: conflict, snapshot: this.snapshot() };
      }
      this.signatures = nextSignatures.map((item) => ({ ...item }));
      this.sequence += 1;
      return { ok: true as const, snapshot: this.snapshot() };
    });
  }

  lockBatch(): ServerSnapshot {
    if (this.batch) {
      this.batch = { ...this.batch, status: 'locked' };
      this.sequence += 1;
    }
    return this.snapshot();
  }

  private findConflictRole(nextSignatures: RoleSignature[]): RoleId | undefined {
    return nextSignatures.find((candidate) =>
      this.signatures.some(
        (existing) =>
          existing.roleId === candidate.roleId &&
          existing.signedAt !== candidate.signedAt &&
          existing.terminal !== candidate.terminal
      )
    )?.roleId;
  }

  private snapshot(): ServerSnapshot {
    return this.getSnapshot();
  }

  private deliver<T>(work: () => T): Promise<T> {
    return new Promise((resolve) => {
      window.setTimeout(() => resolve(work()), LATENCY_MS);
    });
  }
}

/** 单例会签服务端：两个终端标签页共享同一台“服务器” */
export const signingServer = new SigningServer();
