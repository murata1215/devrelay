// AI 回答契約サイクル（2026-11-23 第3版）: response-split.ts の配線ソース静的ガード
// （node:fs、dist/ には依存しない。response-split-wiring.test.mjs と同じ手口）。
//
// これが無いと、将来のリファクタで以下が黙って崩れても気づけない:
// - 保存済みメッセージの読み出し（resolveStoredDeliveryContent）が新たに要約 AI を呼んでしまう
//   （履歴を開くたびに課金が発生する事故）
// - 要約に成功したのにリンクを作れない場合、要約だけを見せてしまう（詳細が消える）

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const source = readFileSync(path.join(serverRoot, 'src/services/response-split.ts'), 'utf8');

describe('response-split.ts: 配線', () => {
  test('generateReplySummary を呼んでいる（ライブ配信のみ）', () => {
    assert.match(source, /generateReplySummary\(/);
  });

  test('resolveStoredDeliveryContent は generateReplySummary を呼ばない（履歴読み出しで新規課金しない）', () => {
    const fnStart = source.indexOf('export function resolveStoredDeliveryContent');
    assert.ok(fnStart > 0, 'resolveStoredDeliveryContent が見つからない');
    const fnBody = source.slice(fnStart);
    assert.ok(!fnBody.includes('generateReplySummary('), 'resolveStoredDeliveryContent 内で generateReplySummary を呼んでいる');
  });

  test('要約 AI 呼び出しは元文全体を対象にし、AI 境界行による本文再利用をしない', () => {
    const fnStart = source.indexOf('export async function resolveLiveDeliveryContent');
    const fnBody = source.slice(fnStart);
    assert.match(fnBody, /const original = cleanAiResponse\(rawContent\)/);
    assert.match(fnBody, /generateReplySummary\(\{ messageId, sessionId, content: original \}\)/);
    assert.ok(!fnBody.includes('splitAiResponse('), '本文の組み立てに AI 境界行を使わないこと');
  });

  test('保存済み要約と有効な共有リンクが揃った場合だけ、本文を要約に置き換える', () => {
    const fnStart = source.indexOf('export function resolveStoredDeliveryContent');
    const fnBody = source.slice(fnStart);
    assert.match(fnBody, /if \(message\.summary && shareable\)/);
    assert.match(fnBody, /return \{ chatText: cleanAiResponse\(message\.content\), shareUrl: null, ttlDays: null \}/);
  });
});
