// プレビュータブ（VS Code 方式）の退行防止ソースガード（2026-11-22、Pulse タブ増殖バグの根治）。
// ChatPage.tsx を文字列検査する（tab-order-rules.test.mjs の「ソースガード」と同じ流儀）。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, '..');
const readSrc = (relPath) => readFileSync(path.join(webRoot, relPath), 'utf8');

describe('ソースガード: tab_order の保存経路が persistTabOrder に一本化されている', () => {
  test('saveTabOrder の直接呼び出しは persistTabOrder の定義1箇所のみ', () => {
    const source = readSrc('src/pages/ChatPage.tsx');
    const matches = source.match(/settingsApi\.saveTabOrder\(/g) ?? [];
    assert.equal(matches.length, 1, 'settingsApi.saveTabOrder の呼び出しが複数箇所にある（persistTabOrder への一本化が崩れている）');
  });

  test('旧パターン（updated.map(t => t.projectId) / newTabs.map(t => t.projectId) を saveTabOrder に直接渡す）が無い', () => {
    const source = readSrc('src/pages/ChatPage.tsx');
    assert.equal(/saveTabOrder\(\s*(updated|newTabs)\.map\(/.test(source), false,
      'saveTabOrder に projectId 列を直接 map して渡す旧パターンが復活している（プレビュータブ除外を書き忘れる余地が生まれる）');
  });

  test('persistTabOrder は collectPersistedTabIds を使っている', () => {
    const source = readSrc('src/pages/ChatPage.tsx');
    assert.ok(source.includes('collectPersistedTabIds('), 'collectPersistedTabIds を呼んでいない');
    assert.ok(source.includes("from '../lib/tab-preview-rules'"));
  });
});

describe('ソースガード: Pulse はプレビュータブ経由でのみタブを開く', () => {
  test('handleConversationSelect は handleSelectProject を直接呼ばない（handleSelectPreviewProject 経由に固定）', () => {
    const source = readSrc('src/pages/ChatPage.tsx');
    const start = source.indexOf('const handleConversationSelect');
    assert.notEqual(start, -1, 'handleConversationSelect が見当たらない');
    const end = source.indexOf('\n  }, [', start);
    const body = source.slice(start, end);
    assert.equal(body.includes('handleSelectProject('), false, 'handleConversationSelect が handleSelectProject を直接呼んでいる（Pulse タブ増殖バグの再発）');
    assert.ok(body.includes('handleSelectPreviewProject('), 'handleConversationSelect が handleSelectPreviewProject を呼んでいない');
  });
});

describe('ソースガード: 右クリックメニューは position:fixed 方式（タブ行コンテナ内への絶対配置ではない）', () => {
  test("ChatPage.tsx に 'fixed z-50'（右クリックメニュー）がある", () => {
    const source = readSrc('src/pages/ChatPage.tsx');
    assert.ok(source.includes('fixed z-50'), '右クリックメニューの position:fixed 方式が見当たらない');
  });
});

describe('ソースガード: 2026-11-18 第3弾の D&D 退行3点が引き続き再導入されていない', () => {
  const source = () => readSrc('src/pages/ChatPage.tsx');

  test('TabBar コンテナに自動スクロール用の onDragOver が無い', () => {
    assert.equal(source().includes('scrollContainerRef'), false);
    assert.equal(/EDGE_PX|STEP_PX/.test(source()), false);
  });

  test('ドラッグの effectAllowed / dropEffect を明示指定していない', () => {
    assert.equal(source().includes('effectAllowed'), false);
    assert.equal(source().includes('dropEffect'), false);
  });

  test('青い棒は border 方式のまま', () => {
    assert.equal(source().includes('border-l-blue-400'), true);
    assert.equal(source().includes('border-r-blue-400'), true);
  });
});
