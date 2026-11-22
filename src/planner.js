const DEFAULT_ROUND_DURATION_MS = 1000;
const DEFAULT_MAX_ROUNDS = 100;

/**
 * 规划滚动重启期间的连接交接。
 *
 * 所有连接状态均为模拟数据，不触碰真实数据库。
 *
 * @param {object} input
 * @param {string} input.targetVersion 目标节点池版本（滚动重启后的新版本）
 * @param {number} input.maxReplacementRatio 每轮最大替换比例 (0, 1]
 * @param {number} [input.roundDurationMs] 每轮的模拟时长
 * @param {number} [input.maxRounds] 最大轮数，超出后剩余连接记为失败回退
 * @param {Array<object>} input.connections 模拟连接列表
 * @param {string} input.connections[].id
 * @param {number} input.connections[].ageMs 连接年龄
 * @param {'none'|'active'} input.connections[].txState 事务状态
 * @param {number} [input.connections[].txRemainingMs] 活动事务预计剩余时间
 * @param {number} [input.connections[].deadlineMs] 请求 deadline（相对计划起点的绝对毫秒数）
 * @param {object} [input.connections[].sessionState] 会话状态，如 { tempTables: [...] }
 * @param {string[]} [input.connections[].stmtCache] prepared statement 缓存
 * @param {string} input.connections[].nodeVersion 当前所在节点池版本
 */
export function planHandoff(input) {
  const {
    targetVersion,
    maxReplacementRatio,
    roundDurationMs = DEFAULT_ROUND_DURATION_MS,
    maxRounds = DEFAULT_MAX_ROUNDS,
    connections,
  } = input;

  if (!targetVersion) throw new TypeError('targetVersion is required');
  if (!(maxReplacementRatio > 0 && maxReplacementRatio <= 1)) {
    throw new RangeError('maxReplacementRatio must be in (0, 1]');
  }
  if (!Array.isArray(connections) || connections.length === 0) {
    throw new TypeError('connections must be a non-empty array');
  }

  const perRoundLimit = Math.max(1, Math.floor(connections.length * maxReplacementRatio));

  const pending = connections
    .filter((c) => c.nodeVersion !== targetVersion)
    .map((c) => ({
      ...c,
      sessionState: c.sessionState ?? {},
      stmtCache: c.stmtCache ?? [],
      txRemainingMs: c.txState === 'active' ? (c.txRemainingMs ?? 0) : 0,
      deadlineMs: c.deadlineMs ?? Infinity,
      drainStarted: false,
    }));

  const rounds = [];
  const fallbacks = [];
  const migrated = [];
  const retainedVersions = new Set(pending.map((c) => c.nodeVersion));
  const releasedVersions = [];

  let now = 0;
  let roundNo = 0;

  while (pending.length > 0 && roundNo < maxRounds) {
    roundNo += 1;
    const actions = [];
    let replacementsThisRound = 0;

    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const conn = pending[i];

      if (!conn.drainStarted) {
        conn.drainStarted = true;
        actions.push({
          connectionId: conn.id,
          action: 'stop-accepting',
          detail: `停止接新请求，连接年龄 ${conn.ageMs}ms，节点版本 ${conn.nodeVersion}`,
        });
      }

      if (conn.txState === 'active') {
        const finishAt = now + conn.txRemainingMs;
        if (finishAt > conn.deadlineMs) {
          // 活动事务无法迁移，deadline 前无法完成，只能回滚
          actions.push({
            connectionId: conn.id,
            action: 'rollback',
            detail: `事务无法在 deadline ${conn.deadlineMs}ms 前完成，回滚并关闭旧连接`,
          });
          fallbacks.push({
            connectionId: conn.id,
            type: 'rollback',
            detail: `活动事务超过请求 deadline，已回滚；剩余 ${conn.txRemainingMs}ms`,
          });
          actions.push({ connectionId: conn.id, action: 'close-old', detail: '旧连接已关闭' });
          pending.splice(i, 1);
          continue;
        }
        if (conn.txRemainingMs > 0) {
          actions.push({
            connectionId: conn.id,
            action: 'wait',
            detail: `等待活动事务提交，剩余 ${conn.txRemainingMs}ms`,
          });
          conn.txRemainingMs = Math.max(0, conn.txRemainingMs - roundDurationMs);
          continue;
        }
        // 事务已在本轮内提交，转为空闲后继续走迁移流程
        conn.txState = 'none';
      }

      if (replacementsThisRound >= perRoundLimit) {
        actions.push({
          connectionId: conn.id,
          action: 'defer',
          detail: `超出每轮最大替换比例 ${maxReplacementRatio}（每轮 ${perRoundLimit} 个），顺延到下一轮`,
        });
        continue;
      }
      replacementsThisRound += 1;

      const tempTables = conn.sessionState.tempTables ?? [];
      if (tempTables.length > 0) {
        // 会话状态（临时表等）无法迁移，只能在新连接上重建会话
        fallbacks.push({
          connectionId: conn.id,
          type: 'session-recreated',
          detail: `临时表 [${tempTables.join(', ')}] 无法迁移，新连接上会话状态丢失，需应用重建`,
        });
      }

      const replacement = {
        id: `${conn.id}@${targetVersion}`,
        nodeVersion: targetVersion,
        rebuiltStatements: [...conn.stmtCache],
      };
      actions.push({
        connectionId: conn.id,
        action: 'migrate',
        detail: `在节点池 ${targetVersion} 建立新连接 ${replacement.id}`,
        replacement,
      });
      if (conn.stmtCache.length > 0) {
        actions.push({
          connectionId: conn.id,
          action: 'rebuild-statements',
          detail: `在新连接重建 prepared statement: ${conn.stmtCache.join(', ')}`,
          statements: [...conn.stmtCache],
        });
      }
      actions.push({ connectionId: conn.id, action: 'close-old', detail: '旧连接已关闭' });

      migrated.push(replacement);
      pending.splice(i, 1);
    }

    // 旧版本节点池在全部引用释放前不能删除
    for (const version of [...retainedVersions]) {
      const stillReferenced = pending.some((c) => c.nodeVersion === version);
      if (!stillReferenced) {
        retainedVersions.delete(version);
        releasedVersions.push(version);
        actions.push({
          connectionId: null,
          action: 'release-version',
          detail: `节点池版本 ${version} 引用已清零，可以删除`,
        });
      }
    }

    rounds.push({ round: roundNo, startedAtMs: now, actions });
    now += roundDurationMs;
  }

  for (const conn of pending) {
    fallbacks.push({
      connectionId: conn.id,
      type: 'max-rounds-exceeded',
      detail: `超过最大轮数 ${maxRounds}，连接仍未完成交接`,
    });
  }

  return {
    rounds,
    fallbacks,
    migrated,
    summary: {
      totalConnections: connections.length,
      migratedCount: migrated.length,
      fallbackCount: fallbacks.length,
      roundsUsed: rounds.length,
      perRoundLimit,
      versionsRetained: [...retainedVersions],
      versionsReleased: releasedVersions,
    },
  };
}
