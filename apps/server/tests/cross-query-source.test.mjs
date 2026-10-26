// 外部 import ゼロの純粋関数（apps/server/src/services/cross-query-guard.ts の
// resolveCrossSourceLabel()）をコンパイル済み dist から直接 import する
// （既存 cross-query-guard.test.mjs と同じ流儀）。
// 2026-10-22 の TruckBoard 誤表示（発信元マシン配下の候補が複数件のとき、無関係な先頭1件を
// 「依頼元プロジェクト名」として名乗らせていた事故）の根治。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCrossSourceLabel } from '../dist/services/cross-query-guard.js';

test('resolveCrossSourceLabel: callerProjectPath が候補と1件一致したらその名前を返す（source: path）', () => {
  const result = resolveCrossSourceLabel({
    callerProjectPath: '/Users/keisukemurata/development/devrelay_flutter',
    candidates: [
      { name: 'TruckBoard', displayName: null, path: '/Users/keisukemurata/Documents/xcode/TruckBoard' },
      { name: 'devrelay_flutter', displayName: null, path: '/Users/keisukemurata/development/devrelay_flutter' },
    ],
    machineLabel: 'KeisukenoMacBook-Air.local/keisukemurata',
  });
  assert.equal(result.label, 'devrelay_flutter');
  assert.equal(result.source, 'path');
});

test('resolveCrossSourceLabel: path 一致時は displayName を name より優先する', () => {
  const result = resolveCrossSourceLabel({
    callerProjectPath: '/opt/devrelay',
    candidates: [
      { name: 'devrelay', displayName: 'DevRelay (本番)', path: '/opt/devrelay' },
    ],
    machineLabel: 'x220/devrelay',
  });
  assert.equal(result.label, 'DevRelay (本番)');
  assert.equal(result.source, 'path');
});

test('resolveCrossSourceLabel: 回帰ケース — path 未送信 + 候補12件(TruckBoard含む) → 無関係な名前を名乗らずマシン名を返す', () => {
  // 実データを模した候補（KeisukenoMacBook-Air.local/keisukemurata 配下の生存プロジェクト）。
  // 旧実装では orderBy なし findMany の先頭が採用され TruckBoard になっていた。
  const candidates = [
    { name: 'pixblog-flutter', displayName: 'pixblog-flutter-mac', path: '/Users/keisukemurata/pixblog-flutter' },
    { name: 'WireframeRunner', displayName: null, path: '/Users/keisukemurata/WireframeRunner' },
    { name: 'TruckBoard', displayName: null, path: '/Users/keisukemurata/Documents/xcode/TruckBoard' },
    { name: 'devrelay_flutter', displayName: null, path: '/Users/keisukemurata/development/devrelay_flutter' },
    { name: 'freeterm', displayName: null, path: '/Users/keisukemurata/freeterm' },
    { name: 'term-flutter', displayName: null, path: '/Users/keisukemurata/term-flutter' },
    { name: 'termapp', displayName: null, path: '/Users/keisukemurata/termapp' },
    { name: 'test001', displayName: null, path: '/Users/keisukemurata/test001' },
    { name: 'test002', displayName: null, path: '/Users/keisukemurata/test002' },
    { name: 'mimamori-flutter-iosbuild', displayName: null, path: '/Users/keisukemurata/mimamori-flutter-iosbuild' },
    { name: 'test-flutter', displayName: null, path: '/Users/keisukemurata/test-flutter' },
    { name: 'chrome-bookmark-flutter', displayName: null, path: '/Users/keisukemurata/chrome-bookmark-flutter' },
  ];
  const result = resolveCrossSourceLabel({
    callerProjectPath: undefined, // #348 未移植の旧 Agent（修正前の macOS）を模す
    candidates,
    machineLabel: 'KeisukenoMacBook-Air.local/keisukemurata',
  });
  assert.equal(result.label, 'KeisukenoMacBook-Air.local/keisukemurata');
  assert.equal(result.source, 'machine');
  assert.notEqual(result.label, 'TruckBoard');
});

test('resolveCrossSourceLabel: callerProjectPath を送ったが候補に一致が無い（削除済み/パス変更）→ マシン名', () => {
  const result = resolveCrossSourceLabel({
    callerProjectPath: '/no/longer/exists',
    candidates: [
      { name: 'a', displayName: null, path: '/path/a' },
      { name: 'b', displayName: null, path: '/path/b' },
    ],
    machineLabel: 'host/user',
  });
  assert.equal(result.label, 'host/user');
  assert.equal(result.source, 'machine');
});

test('resolveCrossSourceLabel: path 未送信 + 候補1件 → その名前（source: soleProject）', () => {
  const result = resolveCrossSourceLabel({
    callerProjectPath: null,
    candidates: [{ name: 'devrelay', displayName: null, path: '/opt/devrelay' }],
    machineLabel: 'x220/devrelay',
  });
  assert.equal(result.label, 'devrelay');
  assert.equal(result.source, 'soleProject');
});

test('resolveCrossSourceLabel: 候補0件 → マシン名', () => {
  const result = resolveCrossSourceLabel({
    callerProjectPath: null,
    candidates: [],
    machineLabel: 'host/user',
  });
  assert.equal(result.label, 'host/user');
  assert.equal(result.source, 'machine');
});

test('resolveCrossSourceLabel: Windows パス（バックスラッシュ・大文字小文字差）でも正規化して一致する', () => {
  const result = resolveCrossSourceLabel({
    callerProjectPath: 'C:\\My Programs\\devrelay-main\\',
    candidates: [
      // ドライブレターが異なる同名プロジェクト（コピー） → 一致しない
      { name: 'devrelay-main-d-drive', displayName: null, path: 'D:\\My Programs\\devrelay-main' },
      // 同じ C ドライブだが大文字小文字・スラッシュ向きが異なる → 正規化後に一致する
      { name: 'devrelay-main', displayName: null, path: 'C:/MY PROGRAMS/DevRelay-Main' },
    ],
    machineLabel: 'win-host/user',
  });
  assert.equal(result.label, 'devrelay-main');
  assert.equal(result.source, 'path');
});
