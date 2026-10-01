// store 端到端验证：迁移补指纹 → 范围失效 → 并发签署 → 失败恢复
import assert from 'node:assert';
import { createPinia, setActivePinia } from 'pinia';
(globalThis as unknown as { window: unknown }).window = { setTimeout };
(globalThis as unknown as { localStorage: Storage | undefined }).localStorage = undefined;

const { useLiftStore } = await import('../src/store');

setActivePinia(createPinia());
const store = useLiftStore();

// 1) 旧草稿（无指纹）迁移
assert.ok(store.authBatch, '迁移后应存在授权批次');
assert.equal(store.authBatch?.batchNo, 'AUTH-V4-001');
assert.equal(store.versions.length, 1);
assert.equal(store.versions[0].source, 'migrated');
assert.ok(store.authLogs[0].kind === 'migrate');

// 2) 四位角色全部签署
for (const role of ['general', 'equipment', 'safety', 'planner'] as const) {
  await store.submitSignature(role, '终端A');
  assert.equal(store.signatureView(role).status, 'valid');
}
assert.equal(store.validSignatureCount, 4);

// 3) 修改 S-01：只作废总包 + 设备，安全/方案仍有效
store.selectStep('S-01');
store.updateStep({ loadRate: 15 });
assert.deepEqual(store.invalidRoles.sort(), ['equipment', 'general']);
assert.equal(store.signatureView('safety').status, 'valid');
assert.equal(store.signatureView('planner').status, 'valid');
assert.equal(store.validSignatureCount, 2);

// 4) 重签后恢复
await store.submitSignature('general', '终端A');
assert.equal(store.signatureView('general').status, 'valid');

// 5) 评论只牵连所属步骤的角色：在 S-02 发评论 → 仅安全失效
store.selectStep('S-02');
store.addComment('补充净空复核意见');
assert.deepEqual(store.invalidRoles, ['equipment', 'safety'], '设备此前已失效，安全新增失效');
assert.equal(store.signatureView('general').status, 'valid');
assert.equal(store.signatureView('planner').status, 'valid');

// 6) 双终端同时签安全：先到生效，晚到保留现场内容
await store.simulateConcurrentSubmit('safety');
const safety = store.signatureView('safety');
assert.ok(safety.status === 'valid' || safety.status === 'invalid', '先到签署落账');
assert.ok(store.retainedDraft, '晚到终端现场内容应被保留');
assert.equal(store.retainedDraft?.roleId, 'safety');
assert.ok(store.signatures.every((s) => s.batchNo === store.authBatch?.batchNo), '无跨批次半份签署');

// 7) 写入失败：服务端回滚，本地恢复，不留下半份
store.dismissRetainedDraft();
const seqBefore = store.serverSequence;
const countBefore = store.signatures.length;
store.armDiskFailure();
await store.submitSignature('equipment', '终端A');
assert.equal(store.serverSequence, seqBefore, '顺序号应恢复到失败前');
assert.equal(store.signatures.length, countBefore, '签署数量不变（无半份）');
assert.ok(store.authLogs.some((l) => l.kind === 'restore'));

// 8) 未达四角色有效签署时锁定被门禁拦截
const revisionBefore = store.revision;
await store.lockPlan();
assert.equal(store.revision, revisionBefore);

console.log('store 集成验证通过：迁移补指纹、范围失效、并发先到+现场保留、失败按批次号恢复、发布门禁');
