/* 合并引擎端到端验证（node 直接运行，localStorage 打桩） */
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear()
};

import { planServer } from '../src/offline/server';
import { BASE_REVISION, seedComments, seedSteps } from '../src/offline/seed';
import type { StepField, SyncBatch } from '../src/offline/types';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

function makeBatch(overrides: Partial<SyncBatch> = {}): SyncBatch {
  return {
    id: `BATCH-${Math.random().toString(36).slice(2, 8)}`,
    deviceName: '测试平板',
    author: '王工',
    baseRevision: BASE_REVISION,
    baselineSteps: JSON.parse(JSON.stringify(seedSteps)),
    baselineComments: JSON.parse(JSON.stringify(seedComments)),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'open',
    changes: [],
    appliedChangeIds: [],
    conflicts: [],
    blocked: [],
    attempts: 0,
    ...overrides
  };
}

function fieldChange(stepId: string, field: StepField, baselineValue: string | number, value: string | number) {
  return {
    id: `CHG-${stepId}-${field}-${Math.random().toString(36).slice(2, 7)}`,
    type: 'stepField' as const,
    changeKey: `${stepId}.${field}`,
    stepId,
    field,
    baselineValue,
    value,
    author: '王工',
    updatedAt: new Date().toISOString()
  };
}

async function main() {
  // ---------- 1. 干净合并：未冲突字段直接入库并出版本 ----------
  console.log('\n[1] 干净三方合并（服务端未动该字段）');
  await planServer.devReset();
  let b1 = makeBatch({ changes: [fieldChange('S-04', 'wind', 6.8, 7.1)] });
  const r1 = await planServer.commitBatch(b1);
  check('改动直接入库', r1.appliedChangeIds.length === 1 && r1.conflicts.length === 0 && r1.blocked.length === 0);
  const f1 = await planServer.finalizeBatch(b1);
  check('合并后版本 +1 → V5', f1.plan.revision === 5, `revision=${f1.plan.revision}`);
  check('风速已更新', f1.plan.steps.find((s) => s.id === 'S-04')?.wind === 7.1);
  check('无新风险', f1.riskReport.newFindings.length === 0);
  check('会签未失效', f1.riskReport.signOffInvalidated === false);
  check('版本发生变化', f1.revisionChanged === true);

  // ---------- 2. 同字段双方修改 → 冲突 ----------
  console.log('\n[2] 双方改过同一字段 → 列冲突');
  await planServer.devReset();
  await planServer.devCoworkerEdit('S-03', 'clearance', 3.1);
  const b2 = makeBatch({ changes: [fieldChange('S-03', 'clearance', 2.8, 1.1)] });
  const r2 = await planServer.commitBatch(b2);
  check('产生 1 个字段冲突', r2.conflicts.length === 1, JSON.stringify(r2.conflicts));
  check('冲突包含三方值', r2.conflicts[0]?.baselineValue === 2.8 && r2.conflicts[0]?.serverValue === 3.1 && r2.conflicts[0]?.localValue === 1.1);
  check('冲突未解决前不能完成', (await planServer.finalizeBatch({ ...b2, conflicts: r2.conflicts }).then(() => false, () => true)));

  // 选择服务端值 → 现场值被丢弃
  const chosenServer = r2.conflicts.map((c) => ({ ...c, resolution: 'server' as const }));
  const r2b = await planServer.commitBatch({ ...b2, conflicts: chosenServer, appliedChangeIds: r2.appliedChangeIds });
  check('选择服务端值后该改动按解决项幂等入库，不再回显冲突', r2b.conflicts.length === 0 && r2b.appliedChangeIds.length === 1);
  const f2 = await planServer.finalizeBatch({ ...b2, conflicts: r2b.conflicts });
  check('保留服务端值 3.1', f2.plan.steps.find((s) => s.id === 'S-03')?.clearance === 3.1);

  // 选择现场值的另一分支
  await planServer.devReset();
  await planServer.devCoworkerEdit('S-03', 'clearance', 3.1);
  const b2c = makeBatch({ changes: [fieldChange('S-03', 'clearance', 2.8, 1.1)] });
  const r2c = await planServer.commitBatch(b2c);
  const chosenLocal = r2c.conflicts.map((c) => ({ ...c, resolution: 'local' as const }));
  await planServer.commitBatch({ ...b2c, conflicts: chosenLocal, appliedChangeIds: r2c.appliedChangeIds });
  const f2c = await planServer.finalizeBatch({ ...b2c, conflicts: chosenLocal });
  check('保留现场值 1.1', f2c.plan.steps.find((s) => s.id === 'S-03')?.clearance === 1.1);

  // ---------- 3. 锁定字段不可覆盖（字段级 & 方案级） ----------
  console.log('\n[3] 锁定内容不能被覆盖');
  await planServer.devReset();
  await planServer.devLockField('S-04', 'wind');
  const b3 = makeBatch({
    changes: [fieldChange('S-04', 'wind', 6.8, 9.5), fieldChange('S-04', 'boom', 48, 50)]
  });
  const r3 = await planServer.commitBatch(b3);
  check('wind 字段被拒绝', r3.blocked.length === 1 && r3.blocked[0].field === 'wind');
  check('未锁定的 boom 正常入库', r3.appliedChangeIds.length === 2);
  const f3 = await planServer.finalizeBatch({ ...b3, conflicts: r3.conflicts, blocked: r3.blocked });
  check('服务端 wind 未被覆盖', f3.plan.steps.find((s) => s.id === 'S-04')?.wind === 6.8);
  check('boom 已更新', f3.plan.steps.find((s) => s.id === 'S-04')?.boom === 50);

  await planServer.devReset();
  await planServer.lockPlan();
  const b3b = makeBatch({ baseRevision: 4, changes: [fieldChange('S-04', 'wind', 6.8, 9.9)] });
  const r3b = await planServer.commitBatch(b3b);
  check('方案锁定发布后字段改动被拒绝', r3b.blocked.length === 1 && r3b.plan.status === 'LOCKED');

  // ---------- 4. 新风险 → 会签失效 + 相关意见重开 ----------
  console.log('\n[4] 净空越过阈值 → 原会签结论失效、相关意见重开');
  await planServer.devReset();
  await planServer.devCompleteSignOff();
  const before = await planServer.pull();
  check('会签已生效', before.signOff.valid === true);
  check('S-03 的两条意见初始为 resolved', before.comments.filter((c) => c.stepId === 'S-03').every((c) => c.status === 'resolved'));
  const b4 = makeBatch({ changes: [fieldChange('S-03', 'clearance', 2.8, 1.1)] });
  const r4 = await planServer.commitBatch(b4);
  const f4 = await planServer.finalizeBatch({ ...b4, conflicts: r4.conflicts });
  check('识别 1 项净空新风险', f4.riskReport.newFindings.length === 1 && f4.riskReport.newFindings[0].field === 'clearance');
  check('会签结论失效', f4.riskReport.signOffInvalidated === true && f4.plan.signOff.valid === false && Boolean(f4.plan.signOff.invalidatedAt));
  check('S-03 相关意见重新打开 2 条', f4.riskReport.reopenedCommentIds.length === 2);
  check('重开意见带原因', f4.plan.comments.find((c) => c.id === 'C-13')?.status === 'open' && Boolean(f4.plan.comments.find((c) => c.id === 'C-13')?.reopenedReason));

  // 无新风险但会签有效时不得失效
  await planServer.devReset();
  await planServer.devCompleteSignOff();
  const b4b = makeBatch({ changes: [fieldChange('S-04', 'wind', 6.8, 6.0)] });
  const r4b = await planServer.commitBatch(b4b);
  const f4b = await planServer.finalizeBatch({ ...b4b, conflicts: r4b.conflicts });
  check('安全字段变化不会使会签失效', f4b.plan.signOff.valid === true);

  // ---------- 5. 失败重试：批次保留、幂等、不重复入库 ----------
  console.log('\n[5] 同步失败保留批次 + 重试幂等');
  await planServer.devReset();
  await planServer.devFailNext(1);
  const b5 = makeBatch({ changes: [fieldChange('S-04', 'wind', 6.8, 5.5)] });
  const firstFail = await planServer.commitBatch(b5).then(() => false, () => true);
  check('首次提交按注入故障失败', firstFail);
  const r5 = await planServer.commitBatch({ ...b5, attempts: 1 });
  check('重试成功且字段入库 1 项', r5.appliedChangeIds.length === 1);
  // 再次提交同一批，服务端不得重复处理
  const r5b = await planServer.commitBatch({ ...b5, attempts: 2, appliedChangeIds: r5.appliedChangeIds });
  check('已成功字段不重复入库', r5b.appliedChangeIds.length === 1);
  const f5 = await planServer.finalizeBatch({ ...b5, conflicts: [] });
  check('合并出版本 V5', f5.plan.revision === 5);
  const f5again = await planServer.finalizeBatch({ ...b5, conflicts: [] });
  check('finalize 幂等：版本不重复递增', f5again.plan.revision === 5 && f5again.snapshotId === f5.snapshotId);
  check('wind 只入一次（值正确）', f5again.plan.steps.find((s) => s.id === 'S-04')?.wind === 5.5);

  // 意见幂等：重试不产生重复意见
  await planServer.devReset();
  await planServer.devFailNext(1);
  const commentChange = {
    id: 'CHG-CMT-1',
    type: 'commentAdd' as const,
    stepId: 'S-02',
    content: '断网现场补充：配电箱已安排迁移',
    author: '王工',
    role: '方案',
    localCommentId: 'C-LOCAL-1',
    createdAt: new Date().toISOString()
  };
  await planServer.commitBatch(makeBatch({ changes: [commentChange] })).catch(() => undefined);
  await planServer.commitBatch(makeBatch({ changes: [commentChange] }));
  const afterComment = await planServer.pull();
  check('意见只入库一次', afterComment.comments.filter((c) => c.clientChangeId === 'CHG-CMT-1').length === 1);

  // ---------- 6. 基线落后：同事改过 S-03，本批只改 S-04，不应误报冲突 ----------
  console.log('\n[6] 基线落后时与当前锁定版本逐字段合并');
  await planServer.devReset();
  await planServer.devCoworkerEdit('S-03', 'clearance', 3.1); // 办公室改动，服务端当前值已是 3.1
  const b6 = makeBatch({ baseRevision: 4, changes: [fieldChange('S-04', 'wind', 6.8, 7.0)] });
  const r6 = await planServer.commitBatch(b6);
  check('未触碰的 S-03 不产生冲突，S-04 干净入库', r6.conflicts.length === 0 && r6.appliedChangeIds.length === 1);
  const f6 = await planServer.finalizeBatch({ ...b6, conflicts: [] });
  check('同事的 S-03 值保留 3.1', f6.plan.steps.find((s) => s.id === 'S-03')?.clearance === 3.1);
  check('现场的 S-04 值并入 7.0', f6.plan.steps.find((s) => s.id === 'S-04')?.wind === 7.0);

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
