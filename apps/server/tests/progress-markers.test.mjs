// 2026-09-09 サイクル: BuildLog summary「不明」調査に伴う進捗マーカー除去（progress-markers.ts）の単体テスト。
// 外部 import ゼロの純粋関数（apps/server/src/services/progress-markers.ts）を
// コンパイル済み dist から直接 import する（stop-reason.test.mjs と同じ流儀）。
// ロジックは agents/linux/src/services/history-compaction.ts の同名関数の写しであり、
// 挙動が一致することもここで確認する。
//
// 2026-09-26 サイクル: get_answer/get_plan から進捗表示行を除外する対応で
// isContextInfoLine / isEphemeralProgressLine / stripAiProgressNoise / sanitizeAiAnswer /
// isMcpAnswerRawMode を追加。生成元ソース（agents/*）との書式一致はソースガードで確認する。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  isProgressMarkerLine,
  stripProgressMarkers,
  isContextInfoLine,
  isEphemeralProgressLine,
  stripAiProgressNoise,
  sanitizeAiAnswer,
  isMcpAnswerRawMode,
} from '../dist/services/progress-markers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');

// ---- isProgressMarkerLine ----

test('isProgressMarkerLine: 日本語の進捗マーカー行を検出する', () => {
  assert.equal(isProgressMarkerLine('🔧 Editを使用中...'), true);
  assert.equal(isProgressMarkerLine('🔧 Bashを使用中...'), true);
});

test('isProgressMarkerLine: 英語の進捗マーカー行を検出する', () => {
  assert.equal(isProgressMarkerLine('🔧 Using Edit...'), true);
  assert.equal(isProgressMarkerLine('🔧 Using Bash...'), true);
});

test('isProgressMarkerLine: 前後の空白があってもマッチする（trim される）', () => {
  assert.equal(isProgressMarkerLine('  🔧 Editを使用中...  '), true);
});

test('isProgressMarkerLine: 通常のテキストは false', () => {
  assert.equal(isProgressMarkerLine('agent-manager.ts に BuildLog の AI 要約機能を追加。'), false);
  assert.equal(isProgressMarkerLine('## 完了報告'), false);
});

test('isProgressMarkerLine: 空行は false', () => {
  assert.equal(isProgressMarkerLine(''), false);
  assert.equal(isProgressMarkerLine('   '), false);
});

test('isProgressMarkerLine: 文字列以外は false（例外を投げない）', () => {
  assert.equal(isProgressMarkerLine(undefined), false);
  assert.equal(isProgressMarkerLine(null), false);
  assert.equal(isProgressMarkerLine(123), false);
});

test('isProgressMarkerLine: 🔧 で始まっても「使用中」でなければ false', () => {
  assert.equal(isProgressMarkerLine('🔧 ツールを修正しました'), false);
});

// ---- stripProgressMarkers ----

test('stripProgressMarkers: 進捗マーカー行を除去する', () => {
  const input = '🔧 Editを使用中...\n実装内容の説明\n🔧 Bashを使用中...\nテスト実行結果';
  const result = stripProgressMarkers(input);
  assert.equal(result.includes('使用中'), false);
  assert.equal(result.includes('実装内容の説明'), true);
  assert.equal(result.includes('テスト実行結果'), true);
});

test('stripProgressMarkers: マーカー行そのものは空行を残さず除去される（隣接行が直接連結される）', () => {
  // マーカー行は continue で読み飛ばされるだけで空行に置換されるわけではないため、
  // マーカー行同士が隣接している場合は間に空行は残らない
  // （agents/linux/src/services/history-compaction.ts の同名関数と挙動一致）
  const input = '本文1行目\n🔧 Editを使用中...\n🔧 Bashを使用中...\n本文2行目';
  const result = stripProgressMarkers(input);
  assert.equal(result, '本文1行目\n本文2行目');
});

test('stripProgressMarkers: 除去で生じた連続空行（マーカー行の前後に元々あった空行）を1行に畳む', () => {
  // agents/linux/tests/history-compaction.test.mjs A4 と同じ入力パターン
  // （マーカー行の前後に実際の空行があるケース）
  const input = [
    '🔧 ToolSearchを使用中...',
    '',
    '🔧 Readを使用中...',
    '',
    '調査の結果、原因は X でした。',
    '',
    '',
    '修正しました。',
  ].join('\n');
  const result = stripProgressMarkers(input);
  assert.equal(result, '調査の結果、原因は X でした。\n\n修正しました。');
});

test('stripProgressMarkers: 先頭の進捗マーカー除去後、先頭空行を残さない', () => {
  const input = '🔧 Editを使用中...\n本文';
  const result = stripProgressMarkers(input);
  assert.equal(result, '本文');
});

test('stripProgressMarkers: 末尾の進捗マーカー除去後、末尾空行を残さない', () => {
  const input = '本文\n🔧 Editを使用中...';
  const result = stripProgressMarkers(input);
  assert.equal(result, '本文');
});

test('stripProgressMarkers: 進捗マーカーのみの入力は空文字になる', () => {
  const input = '🔧 Editを使用中...\n🔧 Bashを使用中...\n🔧 Using Grep...';
  assert.equal(stripProgressMarkers(input), '');
});

test('stripProgressMarkers: 空文字入力は空文字を返す', () => {
  assert.equal(stripProgressMarkers(''), '');
});

test('stripProgressMarkers: 文字列以外は空文字を返す（例外を投げない）', () => {
  assert.equal(stripProgressMarkers(undefined), '');
  assert.equal(stripProgressMarkers(null), '');
});

test('stripProgressMarkers: 進捗マーカーが無い入力は変化しない', () => {
  const input = '実装内容の説明\n\n完了しました。';
  assert.equal(stripProgressMarkers(input), input);
});

test('stripProgressMarkers: 実障害ログの再現（#849 相当、末尾の完了報告が生き残る）', () => {
  const noise = '🔧 ToolSearchを使用中...\n...\n🔧 Bashを使用中...\n...\n🔧 Editを使用中...\n...\n'.repeat(200);
  const completion = '## 完了報告\ncommit hash: abc1234\n変更ファイル: agent-manager.ts, tools.ts';
  const input = noise + completion;
  const result = stripProgressMarkers(input);
  assert.equal(result.includes('## 完了報告'), true);
  assert.equal(result.includes('commit hash: abc1234'), true);
  // ノイズが除去されて全体としては元より大幅に短くなっている
  assert.ok(result.length < input.length);
});

// ---- isContextInfoLine ----
// 2026-09-26 サイクル: get_answer/get_plan から進捗表示行を除外する対応。

test('isContextInfoLine: 📊 Rate Limit 行を検出する', () => {
  assert.equal(isContextInfoLine('📊 Rate Limit: 5h: 0%'), true);
  assert.equal(isContextInfoLine('📊 Rate Limit: 5h: 0% | 7d: 12%'), true);
  assert.equal(isContextInfoLine('📊 Rate Limit: 7d: 12%'), true);
});

test('isContextInfoLine: 前後の空白があってもマッチする（trim される）', () => {
  assert.equal(isContextInfoLine('  📊 Rate Limit: 5h: 0%  '), true);
});

test('isContextInfoLine: 📊 Rate Limit 以外の 📊 行は false（output-parser.ts の Context 行は console.log のみで本文には混入しないが、念のため区別する）', () => {
  assert.equal(isContextInfoLine('📊 Context: 45K / 200K tokens (22%)'), false);
});

test('isContextInfoLine: 本文中の正当な 📊/📝 始まりの行は false（誤って消さない）', () => {
  assert.equal(isContextInfoLine('📊 集計結果は以下のとおり'), false);
  assert.equal(isContextInfoLine('📝 メモ'), false);
  assert.equal(isContextInfoLine('## 📊 計測値'), false);
});

test('isContextInfoLine: 空行・文字列以外は false（例外を投げない）', () => {
  assert.equal(isContextInfoLine(''), false);
  assert.equal(isContextInfoLine('   '), false);
  assert.equal(isContextInfoLine(undefined), false);
  assert.equal(isContextInfoLine(null), false);
});

// ---- isEphemeralProgressLine ----

test('isEphemeralProgressLine: terminal-mode 心拍表示（⏳ [Ns 経過] ...）を検出する', () => {
  assert.equal(isEphemeralProgressLine('⏳ [123s 経過] Cogitating for 28s 64 tokens'), true);
  assert.equal(isEphemeralProgressLine('⏳ [5s 経過] 応答待機中...'), true);
});

test('isEphemeralProgressLine: ⏳ 単体や、⏳ が文中にあるだけの行は false', () => {
  assert.equal(isEphemeralProgressLine('⏳'), false);
  assert.equal(isEphemeralProgressLine('お待ちください⏳'), false);
});

test('isEphemeralProgressLine: 空行・文字列以外は false（例外を投げない）', () => {
  assert.equal(isEphemeralProgressLine(''), false);
  assert.equal(isEphemeralProgressLine(undefined), false);
  assert.equal(isEphemeralProgressLine(null), false);
});

// ---- stripAiProgressNoise ----

test('stripAiProgressNoise: 実 E2E ログの再現（📊 Rate Limit + 🔧 使用中 ×8 + 本文）を除去する', () => {
  const noise = '📊 Rate Limit: 5h: 0%\n' + '🔧 Bashを使用中...\n'.repeat(8);
  const body = '調査の結果、原因が判明しました。修正済みです。';
  const result = stripAiProgressNoise(noise + body);
  assert.equal(result, body);
});

test('stripAiProgressNoise: 本文として意味のある行（⚠️ 途中終了 / 🧭 実行ステップ / ⏱️ タイムアウト / 📖 / 💻）は残る', () => {
  const lines = [
    '⚠️ 途中終了（max_turns）: ここまでの結果です。',
    '🧭 実行ステップ (今回3件 / 累計10件): Read → Edit → Bash',
    '⏱️ タイムアウト: エージェントから応答がありませんでした（30分経過）',
    '📖 README.md を読み込み中...',
    '💻 コマンド実行中: pnpm build',
  ];
  const input = lines.join('\n');
  const result = stripAiProgressNoise(input);
  for (const line of lines) {
    assert.ok(result.includes(line), `残るべき行が消えている: ${line}`);
  }
});

test('stripAiProgressNoise: 先頭・末尾の空行が残らず、連続空行は1行に畳まれる', () => {
  const input = [
    '📊 Rate Limit: 5h: 0%',
    '',
    '🔧 Bashを使用中...',
    '',
    '',
    '本文1行目',
    '',
    '',
    '本文2行目',
    '⏳ [10s 経過] 応答待機中...',
  ].join('\n');
  const result = stripAiProgressNoise(input);
  assert.equal(result, '本文1行目\n\n本文2行目');
});

test('stripAiProgressNoise: 進捗ノイズのみの入力は空文字になる', () => {
  const input = '📊 Rate Limit: 5h: 0%\n🔧 Bashを使用中...\n⏳ [5s 経過] 応答待機中...';
  assert.equal(stripAiProgressNoise(input), '');
});

test('stripAiProgressNoise: 進捗ノイズが無い入力は変化しない', () => {
  const input = '実装内容の説明\n\n完了しました。';
  assert.equal(stripAiProgressNoise(input), input);
});

test('stripAiProgressNoise: 文字列以外は空文字を返す（例外を投げない）', () => {
  assert.equal(stripAiProgressNoise(undefined), '');
  assert.equal(stripAiProgressNoise(null), '');
});

// ---- sanitizeAiAnswer ----

test('sanitizeAiAnswer: 進捗ノイズを除去した本文を返す', () => {
  const input = '📊 Rate Limit: 5h: 0%\n🔧 Bashを使用中...\n調査の結果、原因は X でした。';
  assert.equal(sanitizeAiAnswer(input), '調査の結果、原因は X でした。');
});

test('sanitizeAiAnswer: 除去結果が空になる場合（進捗のみ）は元テキストの trim にフォールバックする（空文字を返さない）', () => {
  const input = '📊 Rate Limit: 5h: 0%\n🔧 Bashを使用中...\n';
  assert.equal(sanitizeAiAnswer(input), input.trim());
  assert.notEqual(sanitizeAiAnswer(input), '');
});

test('sanitizeAiAnswer: 非文字列・空文字は空文字を返す（例外を投げない）', () => {
  assert.equal(sanitizeAiAnswer(undefined), '');
  assert.equal(sanitizeAiAnswer(null), '');
  assert.equal(sanitizeAiAnswer(123), '');
  assert.equal(sanitizeAiAnswer(''), '');
});

// ---- isMcpAnswerRawMode ----

test('isMcpAnswerRawMode: DEVRELAY_MCP_ANSWER_RAW=1 のときのみ true', () => {
  assert.equal(isMcpAnswerRawMode({ DEVRELAY_MCP_ANSWER_RAW: '1' }), true);
  assert.equal(isMcpAnswerRawMode({ DEVRELAY_MCP_ANSWER_RAW: '0' }), false);
  assert.equal(isMcpAnswerRawMode({}), false);
  assert.equal(isMcpAnswerRawMode({ DEVRELAY_MCP_ANSWER_RAW: 'true' }), false);
});

// ---- 生成元ソースガード ----
// 進捗表示行の書式が生成元（agents/*, packages/shared）で変わった場合にここが落ちるようにする。

describe('progress-markers: 生成元ソースとの書式一致ガード', () => {
  test('agents/linux, agents/macos の 📊 Rate Limit 生成文字列が isContextInfoLine に一致する', () => {
    for (const osDir of ['linux', 'macos']) {
      const src = readFileSync(path.join(repoRoot, 'agents', osDir, 'src/services/connection.ts'), 'utf8');
      assert.match(src, /`📊 Rate Limit: \$\{parts\.join\(' \| '\)\}\\n`/, `${osDir}/connection.ts の生成テンプレートが見つからない`);
      // 実際に生成されうる文字列で判定を確認する（5h のみ / 5h+7d の両パターン）
      assert.equal(isContextInfoLine('📊 Rate Limit: 5h: 0%'), true);
      assert.equal(isContextInfoLine('📊 Rate Limit: 5h: 0% | 7d: 12%'), true);
    }
  });

  test('agents/linux の terminal-runner 心拍表示テンプレートが isEphemeralProgressLine に一致する', () => {
    const src = readFileSync(path.join(repoRoot, 'agents/linux/src/services/terminal-runner.ts'), 'utf8');
    assert.match(src, /`\\n⏳ \[\$\{elapsedSec\}s 経過\] /, 'terminal-runner.ts の心拍表示テンプレートが見つからない');
    assert.equal(isEphemeralProgressLine('⏳ [42s 経過] Cogitating for 42s 100 tokens'), true);
    assert.equal(isEphemeralProgressLine('⏳ [42s 経過] 応答待機中...'), true);
  });

  test('packages/shared/src/i18n.ts の progress.usingTool（ja/en）から作った行が isProgressMarkerLine に一致する', () => {
    const src = readFileSync(path.join(repoRoot, 'packages/shared/src/i18n.ts'), 'utf8');
    const m = src.match(/'progress\.usingTool':\s*\{\s*en:\s*'([^']+)',\s*ja:\s*'([^']+)'\s*\}/);
    assert.ok(m, 'progress.usingTool の定義が見つからない');
    const [, enTemplate, jaTemplate] = m;
    const enLine = enTemplate.replace('{tool}', 'Bash');
    const jaLine = jaTemplate.replace('{tool}', 'Bash');
    assert.equal(isProgressMarkerLine(enLine), true);
    assert.equal(isProgressMarkerLine(jaLine), true);
  });
});
