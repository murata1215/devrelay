// クロスユーザー Team Phase C: `//connect` 送信箇所のソース静的ガード（node:fs で実ソースを
// 読み、コンパイル成果物には依存しない。lite-source-guards.test.mjs と同じ手口）。
//
// これが無いと、将来のリファクタで ChatPage.tsx に新しい `sendCommand('//connect ...')` 呼び出しが
// 追加されたときに `shouldSendConnect()` ガードを経由させ忘れても気づけない。2026-11-09 の
// 「クロスユーザー Team のメンバー行には既に他人の projectId が入っているため、ツリーに
// 他人の projectId を並べるとクリック 1 回で踏める」という設計レビューで発見した既知の穴
// （#370 由来の汎用ハンドラ群が `//connect` を無条件に送る）を機械的に固定する。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '..');

function readSource(relPath) {
  return readFileSync(path.join(webRoot, relPath), 'utf8');
}

describe('ChatPage.tsx: sendCommand(`//connect ...`) は既知の箇所数で、全て shouldSendConnect ガード配下にある', () => {
  const source = readSource('src/pages/ChatPage.tsx');

  // `//connect ` を含む sendCommand(Ref.current) 呼び出し行を全て抽出する。
  const connectCallRegex = /send(?:Command|CommandRef\.current)\(`\/\/connect \$\{[^}]+\}`\)/g;
  const matches = [...source.matchAll(connectCallRegex)];

  test('既知の 5 箇所からちょうど 5 件ヒットする（増減したら本テストの更新が必要）', () => {
    assert.equal(matches.length, 5, `expected 5 //connect call sites, found ${matches.length}`);
  });

  test('各呼び出しの直前 400 文字以内に shouldSendConnect( への参照がある', () => {
    for (const m of matches) {
      const idx = m.index ?? 0;
      const before = source.slice(Math.max(0, idx - 400), idx);
      assert.match(
        before,
        /shouldSendConnect\(/,
        `call site at offset ${idx} is not guarded by shouldSendConnect(): ...${before.slice(-120)}`,
      );
    }
  });
});

describe('ChatPage.tsx: クロスユーザー Team Phase C の配線', () => {
  const source = readSource('src/pages/ChatPage.tsx');

  test('handleSelectProject は既存のクロスタブ再選択時に //connect を送らない（shouldSendConnect(existingTab) の早期 return）', () => {
    const idx = source.indexOf('const handleSelectProject = useCallback');
    assert.ok(idx > 0, 'handleSelectProject not found');
    const body = source.slice(idx, idx + 3500);
    assert.match(body, /shouldSendConnect\(existingTab\)/);
  });

  test('handleSend はクロスタブのとき sendCrossAsk を使う（web:cross:ask 経路）', () => {
    const idx = source.indexOf('const handleSend = ()');
    assert.ok(idx > 0, 'handleSend not found');
    const body = source.slice(idx, idx + 1500);
    assert.match(body, /sendCrossAsk\(/);
  });

  test('handleCancelClick はクロスタブで早期 return する（decideComposerCapabilities(...).allowCancel）', () => {
    const idx = source.indexOf('const handleCancelClick = ()');
    assert.ok(idx > 0, 'handleCancelClick not found');
    const body = source.slice(idx, idx + 600);
    assert.match(body, /decideComposerCapabilities\(activeTab\)\.allowCancel/);
  });

  test('addFiles はクロスタブで早期 return する（decideComposerCapabilities(...).allowFiles）', () => {
    const idx = source.indexOf('const addFiles = async');
    assert.ok(idx > 0, 'addFiles not found');
    const body = source.slice(idx, idx + 300);
    assert.match(body, /decideComposerCapabilities\(activeTab\)\.allowFiles/);
  });

  test('ThreadPane/ThreadList はクロスタブで非表示にする（!isCrossTab(activeTab) ガード）', () => {
    const idx = source.indexOf('<ThreadPane');
    assert.ok(idx > 0, 'ThreadPane usage not found');
    const before = source.slice(Math.max(0, idx - 300), idx);
    assert.match(before, /!isCrossTab\(activeTab\)/);
  });
});
