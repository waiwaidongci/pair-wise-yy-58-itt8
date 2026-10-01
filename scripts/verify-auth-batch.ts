// 授权批次核心机制验证脚本（node 直接运行 esbuild 转译后的产物）
import assert from 'node:assert';
import {
  REVIEW_ROLES,
  roleFingerprint,
  rolesCoveringStep,
  rolesCoveringComment,
  SigningServer,
  type RoleSignature
} from '../src/authBatch';
import type { Comment, LiftStep } from '../src/store';

(globalThis as unknown as { window: unknown }).window = { setTimeout };

const steps: LiftStep[] = [
  { id: 'S-01', title: 'a', time: '07:30', loadRate: 0, clearance: 4.2, wind: 3.4, radius: 18, boom: 42, status: 'passed', note: 'n1' },
  { id: 'S-02', title: 'b', time: '08:10', loadRate: 28, clearance: 1.2, wind: 4.1, radius: 22, boom: 46, status: 'blocked', note: 'n2' },
  { id: 'S-03', title: 'c', time: '08:45', loadRate: 76, clearance: 2.8, wind: 5.2, radius: 20, boom: 44, status: 'pending', note: 'n3' },
  { id: 'S-04', title: 'd', time: '09:20', loadRate: 83, clearance: 1.8, wind: 6.8, radius: 24, boom: 48, status: 'pending', note: 'n4' },
  { id: 'S-05', title: 'e', time: '10:05', loadRate: 92, clearance: 1.3, wind: 7.2, radius: 27, boom: 52, status: 'blocked', note: 'n5' },
  { id: 'S-06', title: 'f', time: '10:50', loadRate: 68, clearance: 2.1, wind: 5.6, radius: 21, boom: 45, status: 'pending', note: 'n6' }
];
const comments: Comment[] = [
  { id: 'C-11', author: '周工', role: '安全', content: '净空不足', status: 'open', stepId: 'S-02' }
];

// 1) 指纹确定性
const base: Record<string, string> = {};
for (const role of REVIEW_ROLES) base[role.id] = roleFingerprint(role.id, steps, comments);
for (const role of REVIEW_ROLES) assert.equal(roleFingerprint(role.id, structuredClone(steps), structuredClone(comments)), base[role.id]);

// 2) 改 S-01 只作废总包/设备，安全/方案不受影响
const afterStep = structuredClone(steps);
afterStep[0].loadRate = 12;
assert.deepEqual(rolesCoveringStep('S-01').sort(), ['equipment', 'general']);
assert.notEqual(roleFingerprint('general', afterStep, comments), base.general);
assert.notEqual(roleFingerprint('equipment', afterStep, comments), base.equipment);
assert.equal(roleFingerprint('safety', afterStep, comments), base.safety);
assert.equal(roleFingerprint('planner', afterStep, comments), base.planner);

// 3) 评论纳入指纹：S-02 新增评论只牵连安全
const afterComment = structuredClone(comments);
afterComment.push({ id: 'C-99', author: 'x', role: '方案', content: 'new', status: 'open', stepId: 'S-02' });
assert.deepEqual(rolesCoveringComment(afterComment[1]), ['safety']);
assert.notEqual(roleFingerprint('safety', steps, afterComment), base.safety);
assert.equal(roleFingerprint('general', steps, afterComment), base.general);
assert.equal(roleFingerprint('equipment', steps, afterComment), base.equipment);
assert.equal(roleFingerprint('planner', steps, afterComment), base.planner);

// 4) 并发：两终端同角色同顺序号提交，先到生效、晚到 role-taken
const server = new SigningServer();
const batch = { batchNo: 'AUTH-V4-001', planRevision: 4, openedAt: 'now', status: 'open' as const };
const opened = await server.openBatch(batch, 0, []);
assert.ok(opened.ok);
const seq = opened.snapshot.sequence;

const mk = (terminal: string, stamp: number): RoleSignature => ({
  roleId: 'safety',
  signer: '周工',
  batchNo: 'AUTH-V4-001',
  frozenFingerprint: base.safety,
  signedAt: new Date(stamp).toISOString(),
  terminal
});
const [a, b] = await Promise.all([
  server.submit('AUTH-V4-001', seq, [mk('终端A', 1)]),
  server.submit('AUTH-V4-001', seq, [mk('终端B', 2)])
]);
assert.ok(a.ok, '终端A 应当先到生效');
assert.equal(b.ok, false);
if (!b.ok) assert.equal(b.reason, 'role-taken');
assert.equal(a.snapshot.signatures[0].terminal, '终端A');

// 5) 写入失败：服务端状态不变，不会出现半份签署
const before = server.getSnapshot();
server.armNextSubmit('disk');
const failed = await server.submit('AUTH-V4-001', before.sequence, [mk('终端B', 3)]);
assert.equal(failed.ok, false);
assert.deepEqual(server.getSnapshot(), before);

// 6) 批次号不符 / 旧批次提交被拒
const stale = await server.submit('AUTH-V3-999', server.getSnapshot().sequence, []);
assert.equal(stale.ok, false);
if (!stale.ok) assert.equal(stale.reason, 'stale-batch');

console.log('全部断言通过：指纹范围冻结/范围外不连坐/并发先到/失败无半份/批次号恢复');
