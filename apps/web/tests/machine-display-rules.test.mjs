// aisignage/lfuser クリックで全画面真っ白になった障害（2026-09-15）の直接原因である
// `Machine.managementInfo`（Agent 由来の未検証 JSON）の正規化ロジックを、コンパイル済み dist-test から
// 直接 import して検証する（capability-config-rules.test.mjs と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeManagementInfo,
  formatDateTimeSafe,
} from '../dist-test/lib/machine-display-rules.js';

// ---- normalizeManagementInfo ----

test('normalizeManagementInfo: null は null（フォールバック表示に流れる）', () => {
  assert.equal(normalizeManagementInfo(null), null);
});

test('normalizeManagementInfo: undefined は null', () => {
  assert.equal(normalizeManagementInfo(undefined), null);
});

test('normalizeManagementInfo: 実データ相当の {}（空オブジェクト）は null（今回の障害の直接原因）', () => {
  // aisignage/lfuser の managementInfo が実際にこの形だった。`{}` は truthy なので旧コードの
  // `managementInfo && managementInfo.commands.length > 0` を通過し、直後の `.commands.length` で
  // TypeError を投げていた。
  assert.equal(normalizeManagementInfo({}), null);
});

test('normalizeManagementInfo: commands が存在しない（os のみ）ときも null', () => {
  assert.equal(normalizeManagementInfo({ os: 'win32' }), null);
});

test('normalizeManagementInfo: commands が null のときも null', () => {
  assert.equal(normalizeManagementInfo({ commands: null }), null);
});

test('normalizeManagementInfo: commands が配列でない（文字列）ときも null', () => {
  assert.equal(normalizeManagementInfo({ commands: 'x' }), null);
});

test('normalizeManagementInfo: commands が空配列のときは commands:[] を返す（null ではない）', () => {
  const result = normalizeManagementInfo({ commands: [] });
  assert.deepEqual(result, { os: '', installType: '', commands: [] });
});

test('normalizeManagementInfo: 配列そのもの（Array.isArray）は null', () => {
  assert.equal(normalizeManagementInfo([]), null);
});

test('normalizeManagementInfo: プリミティブ（数値/文字列/真偽値）は null', () => {
  assert.equal(normalizeManagementInfo(42), null);
  assert.equal(normalizeManagementInfo('x'), null);
  assert.equal(normalizeManagementInfo(true), null);
});

test('normalizeManagementInfo: label/command が両方 string の要素だけを残す（不正要素は捨てる）', () => {
  const result = normalizeManagementInfo({
    os: 'linux',
    installType: 'npm',
    commands: [
      { label: '再起動', command: 'systemctl restart devrelay-agent' },
      { label: 123, command: 'x' }, // label が数値 → 捨てる
      { label: 'y' }, // command 欠損 → 捨てる
      null, // null 要素 → 捨てる
      'not-an-object', // オブジェクトでない → 捨てる
    ],
  });
  assert.deepEqual(result, {
    os: 'linux',
    installType: 'npm',
    commands: [{ label: '再起動', command: 'systemctl restart devrelay-agent' }],
  });
});

test('normalizeManagementInfo: os/installType が欠損・非 string のときは空文字にフォールバックする', () => {
  const result = normalizeManagementInfo({ os: 42, installType: undefined, commands: [] });
  assert.deepEqual(result, { os: '', installType: '', commands: [] });
});

test('normalizeManagementInfo: 正常形はそのまま正規化される', () => {
  const result = normalizeManagementInfo({
    os: 'darwin',
    installType: 'homebrew',
    commands: [
      { label: '再起動', command: 'brew services restart devrelay-agent' },
      { label: '停止', command: 'brew services stop devrelay-agent' },
    ],
  });
  assert.deepEqual(result, {
    os: 'darwin',
    installType: 'homebrew',
    commands: [
      { label: '再起動', command: 'brew services restart devrelay-agent' },
      { label: '停止', command: 'brew services stop devrelay-agent' },
    ],
  });
});

// ---- formatDateTimeSafe ----

test('formatDateTimeSafe: null はフォールバック "-" を返す', () => {
  assert.equal(formatDateTimeSafe(null), '-');
});

test('formatDateTimeSafe: undefined はフォールバック "-" を返す', () => {
  assert.equal(formatDateTimeSafe(undefined), '-');
});

test('formatDateTimeSafe: 空文字はフォールバック "-" を返す', () => {
  assert.equal(formatDateTimeSafe(''), '-');
});

test('formatDateTimeSafe: 不正な日付文字列はフォールバックを返す（RangeError を投げない）', () => {
  assert.equal(formatDateTimeSafe('not-a-date'), '-');
});

test('formatDateTimeSafe: カスタム fallback を指定できる', () => {
  assert.equal(formatDateTimeSafe('not-a-date', '(unknown)'), '(unknown)');
});

test('formatDateTimeSafe: 正常な ISO 文字列は toLocaleString() 相当の文字列を返す（空文字/フォールバックではない）', () => {
  const result = formatDateTimeSafe('2026-09-15T12:00:00.000Z');
  assert.notEqual(result, '-');
  assert.equal(typeof result, 'string');
  assert.ok(result.length > 0);
});

test('formatDateTimeSafe: 数値文字列 "0"（epoch）も有効な日付として処理される', () => {
  const result = formatDateTimeSafe('1970-01-01T00:00:00.000Z');
  assert.notEqual(result, '-');
});
