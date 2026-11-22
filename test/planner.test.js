import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planHandoff } from '../src/planner.js';

const base = {
  targetVersion: 'v2',
  maxReplacementRatio: 1,
  roundDurationMs: 1000,
};

function actionsFor(plan, connectionId) {
  return plan.rounds.flatMap((r) =>
    r.actions.filter((a) => a.connectionId === connectionId).map((a) => a.action),
  );
}

test('长事务：deadline 内可完成则等待提交后迁移，不回滚', () => {
  const plan = planHandoff({
    ...base,
    connections: [
      {
        id: 'c1',
        ageMs: 60_000,
        txState: 'active',
        txRemainingMs: 3000,
        deadlineMs: 5000,
        sessionState: {},
        stmtCache: [],
        nodeVersion: 'v1',
      },
    ],
  });

  const actions = actionsFor(plan, 'c1');
  assert.ok(actions.includes('stop-accepting'));
  assert.ok(actions.includes('wait'));
  assert.ok(actions.includes('migrate'));
  assert.ok(!actions.includes('rollback'));
  assert.equal(plan.fallbacks.length, 0);
  assert.equal(plan.migrated[0].nodeVersion, 'v2');
});

test('长事务：超过 deadline 则回滚并记录失败回退', () => {
  const plan = planHandoff({
    ...base,
    connections: [
      {
        id: 'c1',
        ageMs: 60_000,
        txState: 'active',
        txRemainingMs: 8000,
        deadlineMs: 2000,
        sessionState: {},
        stmtCache: [],
        nodeVersion: 'v1',
      },
    ],
  });

  const actions = actionsFor(plan, 'c1');
  assert.ok(actions.includes('rollback'));
  assert.ok(actions.includes('close-old'));
  assert.ok(!actions.includes('migrate'));
  assert.equal(plan.fallbacks[0].type, 'rollback');
  assert.equal(plan.migrated.length, 0);
});

test('空闲连接：按最大替换比例分轮迁移', () => {
  const connections = ['c1', 'c2', 'c3', 'c4'].map((id) => ({
    id,
    ageMs: 10_000,
    txState: 'none',
    sessionState: {},
    stmtCache: [],
    nodeVersion: 'v1',
  }));
  const plan = planHandoff({ ...base, maxReplacementRatio: 0.5, connections });

  assert.equal(plan.summary.perRoundLimit, 2);
  assert.equal(plan.rounds.length, 2);
  for (const round of plan.rounds) {
    const migrates = round.actions.filter((a) => a.action === 'migrate');
    assert.ok(migrates.length <= 2);
  }
  const defers = plan.rounds.flatMap((r) => r.actions).filter((a) => a.action === 'defer');
  assert.ok(defers.length > 0);
  assert.equal(plan.migrated.length, 4);
});

test('语句缓存：prepared statement 在新连接上逐条重建', () => {
  const plan = planHandoff({
    ...base,
    connections: [
      {
        id: 'c1',
        ageMs: 5_000,
        txState: 'none',
        sessionState: {},
        stmtCache: ['stmt_select_user', 'stmt_insert_order'],
        nodeVersion: 'v1',
      },
    ],
  });

  const rebuild = plan.rounds
    .flatMap((r) => r.actions)
    .find((a) => a.action === 'rebuild-statements');
  assert.deepEqual(rebuild.statements, ['stmt_select_user', 'stmt_insert_order']);
  assert.deepEqual(plan.migrated[0].rebuiltStatements, [
    'stmt_select_user',
    'stmt_insert_order',
  ]);
});

test('节点切换：旧版本在全部引用释放后才可删除', () => {
  const connections = ['c1', 'c2', 'c3'].map((id) => ({
    id,
    ageMs: 20_000,
    txState: 'none',
    sessionState: {},
    stmtCache: [],
    nodeVersion: 'v1',
  }));
  const plan = planHandoff({ ...base, maxReplacementRatio: 0.34, connections });

  assert.equal(plan.summary.perRoundLimit, 1);
  assert.equal(plan.rounds.length, 3);

  // 前两轮仍有引用，不能出现 release-version
  for (const round of plan.rounds.slice(0, -1)) {
    assert.ok(!round.actions.some((a) => a.action === 'release-version'));
  }
  const lastRound = plan.rounds.at(-1);
  const release = lastRound.actions.find((a) => a.action === 'release-version');
  assert.ok(release, '最后一轮应释放旧版本');
  assert.deepEqual(plan.summary.versionsReleased, ['v1']);
  assert.deepEqual(plan.summary.versionsRetained, []);
  assert.ok(plan.migrated.every((m) => m.nodeVersion === 'v2'));
});

test('会话状态：临时表无法迁移，记录 session-recreated 回退', () => {
  const plan = planHandoff({
    ...base,
    connections: [
      {
        id: 'c1',
        ageMs: 8_000,
        txState: 'none',
        sessionState: { tempTables: ['tmp_report'] },
        stmtCache: [],
        nodeVersion: 'v1',
      },
    ],
  });

  assert.equal(plan.fallbacks.length, 1);
  assert.equal(plan.fallbacks[0].type, 'session-recreated');
  assert.match(plan.fallbacks[0].detail, /tmp_report/);
  assert.equal(plan.migrated.length, 1);
});

test('输入校验：非法比例与空连接列表抛错', () => {
  assert.throws(() => planHandoff({ ...base, maxReplacementRatio: 0, connections: [{}] }), RangeError);
  assert.throws(() => planHandoff({ ...base, connections: [] }), TypeError);
});
