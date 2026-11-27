// 詳細ページが本文用要約を再掲せず、保存した元文を返すことの静的ガード。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const source = readFileSync(path.join(serverRoot, 'src/routes/response-share-api.ts'), 'utf8');

test('response-share: 詳細ページは保存された元文をそのまま返す', () => {
  assert.match(source, /const content = cleanAiResponse\(message\.content\)/);
  assert.ok(!source.includes('## 詳細'), '元文を再構成する見出しを足さないこと');
  assert.ok(!source.includes('splitAiResponse'), '本文と詳細を再結合しないこと');
});
