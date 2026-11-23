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

  test('要約 AI 呼び出しは境界行が無い場合（!hasDetailSection）のみに置かれている', () => {
    const fnStart = source.indexOf('export async function resolveLiveDeliveryContent');
    const fnBody = source.slice(fnStart);
    const hasDetailIdx = fnBody.indexOf('if (hasDetailSection(result))');
    const summaryIdx = fnBody.indexOf('generateReplySummary(');
    assert.ok(hasDetailIdx > 0 && summaryIdx > hasDetailIdx, '境界行分岐より後ろ（= else 相当）に要約呼び出しがあること');
  });
});
