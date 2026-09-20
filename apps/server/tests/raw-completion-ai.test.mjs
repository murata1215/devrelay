// raw-completion Phase 2（Codex 経路の追加）の `ai` 選択に関する単体テスト。
// 外部 import ゼロの純粋関数（apps/server/src/services/raw-completion-ai.ts）を
// コンパイル済み dist から直接 import する（raw-completion-guard.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RAW_AI_DEFAULT,
  isRawAi,
  resolveRawAi,
  decideRawAiGate,
  validateRawCodexModel,
} from '../dist/services/raw-completion-ai.js';

// ---- isRawAi ----

test('isRawAi: claude/codex は true', () => {
  assert.equal(isRawAi('claude'), true);
  assert.equal(isRawAi('codex'), true);
});

test('isRawAi: それ以外は false', () => {
  assert.equal(isRawAi('gemini'), false);
  assert.equal(isRawAi('devin'), false);
  assert.equal(isRawAi(''), false);
  assert.equal(isRawAi(undefined), false);
  assert.equal(isRawAi(null), false);
  assert.equal(isRawAi(123), false);
});

// ---- resolveRawAi ----

test('resolveRawAi: 未指定は既定値 claude', () => {
  const result = resolveRawAi(undefined);
  assert.deepEqual(result, { ok: true, ai: 'claude' });
  assert.equal(RAW_AI_DEFAULT, 'claude');
});

test('resolveRawAi: null / 空文字も既定値 claude', () => {
  assert.deepEqual(resolveRawAi(null), { ok: true, ai: 'claude' });
  assert.deepEqual(resolveRawAi(''), { ok: true, ai: 'claude' });
});

test('resolveRawAi: claude を明示指定できる', () => {
  assert.deepEqual(resolveRawAi('claude'), { ok: true, ai: 'claude' });
});

test('resolveRawAi: codex を指定できる', () => {
  assert.deepEqual(resolveRawAi('codex'), { ok: true, ai: 'codex' });
});

test('resolveRawAi: 不正値は ok:false でエラーメッセージを返す', () => {
  const result = resolveRawAi('gemini');
  assert.equal(result.ok, false);
  assert.match(result.error, /Invalid ai/);
});

test('resolveRawAi: 数値・オブジェクト等の非文字列も不正値扱い', () => {
  assert.equal(resolveRawAi(123).ok, false);
  assert.equal(resolveRawAi({}).ok, false);
  assert.equal(resolveRawAi(['codex']).ok, false);
});

// ---- decideRawAiGate ----

test('decideRawAiGate: ai=claude は availableAiTools/capability を一切見ずに常に ok', () => {
  const result = decideRawAiGate({ ai: 'claude', availableAiTools: [], hasCodexCapability: false });
  assert.deepEqual(result, { ok: true });
});

test('decideRawAiGate: ai=codex は availableAiTools に codex が無ければ NG', () => {
  const result = decideRawAiGate({ ai: 'codex', availableAiTools: ['claude'], hasCodexCapability: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /Codex CLI/);
});

test('decideRawAiGate: ai=codex は capability 未申告なら NG（インストール済みでも）', () => {
  const result = decideRawAiGate({ ai: 'codex', availableAiTools: ['claude', 'codex'], hasCodexCapability: false });
  assert.equal(result.ok, false);
  assert.match(result.error, /raw-completion-codex 未対応|does not support raw-completion|'u'/);
});

test('decideRawAiGate: ai=codex は availableAiTools に codex を含み capability 申告済みなら ok', () => {
  const result = decideRawAiGate({ ai: 'codex', availableAiTools: ['claude', 'codex'], hasCodexCapability: true });
  assert.deepEqual(result, { ok: true });
});

test('decideRawAiGate: 旧 Agent が capability 未申告のまま ai=codex を無言実行しないよう必ず弾く', () => {
  // 「自動フォールバック禁止」の回帰テスト: availableAiTools に codex があっても capability が無ければ拒否する
  const result = decideRawAiGate({ ai: 'codex', availableAiTools: ['codex'], hasCodexCapability: false });
  assert.equal(result.ok, false);
});

// ---- validateRawCodexModel ----

const CATALOG_IDS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'];

test('validateRawCodexModel: 未指定は ok（CLI 既定モデルへフォールバック）', () => {
  assert.deepEqual(validateRawCodexModel(undefined, CATALOG_IDS), { ok: true });
  assert.deepEqual(validateRawCodexModel('', CATALOG_IDS), { ok: true });
});

test('validateRawCodexModel: terra/sol はカタログ内なので ok', () => {
  assert.deepEqual(validateRawCodexModel('gpt-5.6-terra', CATALOG_IDS), { ok: true });
  assert.deepEqual(validateRawCodexModel('gpt-5.6-sol', CATALOG_IDS), { ok: true });
});

test('validateRawCodexModel: カタログ外のモデル ID は NG', () => {
  const result = validateRawCodexModel('gpt-9.9-unknown', CATALOG_IDS);
  assert.equal(result.ok, false);
  assert.match(result.error, /Unknown Codex model/);
});

test('validateRawCodexModel: 危険文字を含む値は NG（catalog 一致チェックより先に弾く）', () => {
  for (const dangerous of ['gpt-5.6-terra"; rm -rf /', "gpt-5.6-terra'", 'gpt-5.6-terra\n', 'gpt-5.6 terra', 'gpt-5.6-terra$(x)']) {
    const result = validateRawCodexModel(dangerous, CATALOG_IDS);
    assert.equal(result.ok, false, `expected NG for ${JSON.stringify(dangerous)}`);
    assert.match(result.error, /unsafe characters/);
  }
});

test('validateRawCodexModel: Claude 側の許可リストには一切影響しない（関数自体が catalogIds を引数で受け取るだけ）', () => {
  // claude-opus-5 等の Claude モデル ID を codex カタログに対して検証すると NG になる
  // （catalogIds を呼び出し元が変えれば Claude 用にも使い回せるが、本関数は Codex 専用として呼ばれる想定）
  const result = validateRawCodexModel('claude-opus-5', CATALOG_IDS);
  assert.equal(result.ok, false);
});
