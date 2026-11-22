# database-connection-handoff-migration-planner
规划数据库连接在滚动重启中的安全交接

> **说明：本项目中所有连接状态（事务、临时表、prepared statement、节点版本等）均为模拟数据，不连接任何真实数据库。**

## 背景

数据库滚动重启期间，已有连接上可能持有事务、临时表和 prepared statement。连接池若直接断开旧连接，应用会出现重复提交或状态丢失。本工具根据连接状态规划分批交接：停止接新请求 → 排空事务 → 迁移会话 → 关闭旧连接。

## 运行环境

- Node.js 24.16.0+

## 使用

```js
import { planHandoff } from './src/planner.js';

const plan = planHandoff({
  targetVersion: 'v2',        // 目标节点池版本
  maxReplacementRatio: 0.5,   // 每轮最大替换比例
  roundDurationMs: 1000,      // 每轮模拟时长
  connections: [
    {
      id: 'c1',
      ageMs: 60000,                 // 连接年龄
      txState: 'active',            // 'none' | 'active'
      txRemainingMs: 3000,          // 活动事务预计剩余时间
      deadlineMs: 5000,             // 请求 deadline
      sessionState: { tempTables: ['tmp_report'] },
      stmtCache: ['stmt_select_user'],
      nodeVersion: 'v1',
    },
  ],
});
```

## 规划规则

- **停止接新请求**：旧版本连接在第一轮标记为 draining。
- **活动事务不能迁移**：只能等待提交；若无法在请求 deadline 前完成则回滚，记入 `fallbacks`。
- **会话状态不能迁移**：临时表等会话状态随旧连接销毁，记录 `session-recreated` 回退，需应用在新连接重建。
- **prepared statement**：旧连接关闭前在新连接上逐条重建（`rebuild-statements`）。
- **分批替换**：每轮迁移数不超过 `floor(总数 × maxReplacementRatio)`（至少 1 个），其余顺延。
- **旧节点池版本**：在全部引用释放前保留，引用清零后输出 `release-version`。

## 输出

- `rounds`：每轮的连接动作列表（`stop-accepting` / `wait` / `defer` / `migrate` / `rebuild-statements` / `rollback` / `close-old` / `release-version`）。
- `fallbacks`：失败回退（`rollback` / `session-recreated` / `max-rounds-exceeded`）。
- `migrated`：成功迁移的新连接（含重建的语句缓存）。
- `summary`：总数、迁移数、回退数、轮数、版本保留/释放情况。

## 测试

```sh
node --test
```

覆盖长事务（等待与回滚）、空闲连接分批迁移、语句缓存重建、节点版本切换与会话状态回退。
