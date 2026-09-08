// core#336: connection.ts の完了 payload が TDZ (temporal dead zone) バグを再発させていないかの回帰テスト。
//
// 背景: 完了コールバックは `const aiResult = await sendPromptToAi(..., callback, ...)` の
// Promise 実行中（＝ aiResult 変数の初期化が完了する前）に発火する。そのため、もしコールバック
// 内部で `aiResult.extractedSessionId` を直接参照すると
// "Cannot access 'aiResult' before initialization" で全 AI 完了報告が例外落ちする。
// この対策として `OutputCallback` の第4引数 `extractedSessionId` を追加し、コールバック内では
// 必ずその引数を使うことにした（`aiResult`/`retryResult` 変数はコールバック外でのみ安全に参照できる）。
//
// 外部 import ゼロではないが（fs 読み込みのみ）、他の回帰テストと同じ流儀でソースを直接読んで
// テキストパターンを検証する（ビルド成果物ではなく src を見る＝リファクタで消えないようにするため）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONNECTION_TS = join(__dirname, '..', 'src', 'services', 'connection.ts');

test('output-callback-tdz: 完了 payload の aiSessionId はコールバック引数 extractedSessionId を使う（2 箇所以上）', async () => {
  const src = await readFile(CONNECTION_TS, 'utf-8');
  const matches = src.match(/aiSessionId:\s*extractedSessionId,/g) || [];
  assert.ok(matches.length >= 2, `aiSessionId: extractedSessionId, の出現数が想定より少ない (${matches.length})`);
});

test('output-callback-tdz: 完了 payload が aiResult.extractedSessionId / retryResult.extractedSessionId を直接使っていない（TDZ 再発防止）', async () => {
  const src = await readFile(CONNECTION_TS, 'utf-8');
  assert.equal(/aiSessionId:\s*aiResult\.extractedSessionId/.test(src), false, 'aiSessionId: aiResult.extractedSessionId が再発している（TDZ バグ）');
  assert.equal(/aiSessionId:\s*retryResult\.extractedSessionId/.test(src), false, 'aiSessionId: retryResult.extractedSessionId が再発している（TDZ バグ）');
});

test('output-callback-tdz: OutputCallback のコールバック引数に extractedSessionId が定義されている', async () => {
  const src = await readFile(CONNECTION_TS, 'utf-8');
  // #377: 第5引数 stopReason を追加したため、末尾の `)` を許容する形に更新（第4引数までの存在を確認する主旨は不変）
  assert.ok(/async \(output, isComplete, usageData, extractedSessionId, stopReason\)/.test(src), 'コールバックシグネチャに extractedSessionId 第4引数 / stopReason 第5引数が見当たらない');
});

test('#377: 完了 payload が stopReason を配線している（2 箇所以上、配線忘れ検出）', async () => {
  const src = await readFile(CONNECTION_TS, 'utf-8');
  const matches = src.match(/^\s*stopReason,\s*$/gm) || [];
  assert.ok(matches.length >= 2, `stopReason, の出現数が想定より少ない (${matches.length})`);
});
