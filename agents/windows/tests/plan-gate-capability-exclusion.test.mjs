// サイクルS1（2026-11-12）: agents/windows は claude CLI を直接 spawn する構造のため
// in-process PreToolUse フックを実装できない。`'plan-gate-hook'` capability を誤って申告すると、
// サーバー側が「プランモードの Bash ゲートが機能している」と誤認し、クロスユーザー ask を
// 通してしまう（cross-ask-isolation-rules.ts の fail-closed 判定が無意味化する）。
// 静的ガード（node:fs のみ、dist/ には依存しない。cross-ask-isolation.test.mjs と同じ手口）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONNECTION_TS = join(__dirname, '..', 'src', 'services', 'connection.ts');

test("agent:connect の capabilities 配信が AGENT_CAPABILITIES から 'plan-gate-hook' を除外している", async () => {
  const src = await readFile(CONNECTION_TS, 'utf-8');
  const idx = src.indexOf('capabilities: AGENT_CAPABILITIES.filter(');
  assert.ok(idx > 0, 'capabilities: AGENT_CAPABILITIES.filter( が見当たらない');
  const line = src.slice(idx, src.indexOf('\n', idx));
  assert.match(line, /c !== 'plan-gate-hook'/, "capabilities フィルタに c !== 'plan-gate-hook' が無い");
});

test("agent:connect の capabilities 配信が（既存どおり）AGENT_CAPABILITIES から 'raw-completion' も除外している（回帰防止）", async () => {
  const src = await readFile(CONNECTION_TS, 'utf-8');
  const idx = src.indexOf('capabilities: AGENT_CAPABILITIES.filter(');
  assert.ok(idx > 0, 'capabilities: AGENT_CAPABILITIES.filter( が見当たらない');
  const line = src.slice(idx, src.indexOf('\n', idx));
  assert.match(line, /c !== 'raw-completion'/, "capabilities フィルタに c !== 'raw-completion' が無い");
});
