// 2026-11-25: 日本語ユーザー名の Windows で Agent が起動しなかった件の再発防止テスト。
// win-script-file.ts（.vbs/.cmd/.ps1 を Windows が読める文字コードで書く小物）の単体テスト。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeVbs, encodePs1, toCmdPath, encodeCmd, hasNonAscii,
  buildStartAgentCmd, buildClaudeWrapperCmd,
} from '../dist/services/win-script-file.js';

const ENV = {
  USERPROFILE: 'C:\\Users\\神野嘉高',
  APPDATA: 'C:\\Users\\神野嘉高\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\神野嘉高\\AppData\\Local',
};

test('encodeVbs: UTF-16LE + BOM で日本語がそのまま往復する', () => {
  const s = 'WshShell.Run """C:\\Users\\神野嘉高\\a.cmd""", 0, False';
  const buf = encodeVbs(s);
  assert.deepEqual([...buf.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(buf.subarray(2).toString('utf16le'), s);
});

test('encodePs1: UTF-8 + BOM', () => {
  const buf = encodePs1('Write-Host 神野');
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(buf.subarray(3).toString('utf8'), 'Write-Host 神野');
});

test('toCmdPath: 一番具体的な環境変数（APPDATA）に置き換わる・大文字小文字を無視', () => {
  assert.equal(
    toCmdPath('C:\\Users\\神野嘉高\\AppData\\Roaming\\devrelay\\node\\node.exe', ENV),
    '%APPDATA%\\devrelay\\node\\node.exe',
  );
  assert.equal(toCmdPath('c:\\users\\神野嘉高\\.local\\bin\\claude.exe', ENV), '%USERPROFILE%\\.local\\bin\\claude.exe');
  assert.equal(toCmdPath('C:\\Users\\神野嘉高\\AppData\\Local\\x.exe', ENV), '%LOCALAPPDATA%\\x.exe');
});

test('toCmdPath: 前方一致でも別フォルダ（神野嘉高2）は置き換えない・該当なしはそのまま', () => {
  assert.equal(toCmdPath('C:\\Users\\神野嘉高2\\x.exe', ENV), 'C:\\Users\\神野嘉高2\\x.exe');
  assert.equal(toCmdPath('C:\\Program Files\\nodejs\\node.exe', ENV), 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(toCmdPath('C:\\x', {}), 'C:\\x');
});

test('buildStartAgentCmd: 日本語ユーザー名でも ASCII だけになり chcp を入れない', () => {
  const text = buildStartAgentCmd(
    'C:\\Users\\神野嘉高\\AppData\\Roaming\\devrelay\\node\\node.exe',
    'C:\\Users\\神野嘉高\\AppData\\Roaming\\devrelay\\agent\\agents\\linux\\dist\\index.js',
    'C:\\Users\\神野嘉高\\AppData\\Roaming\\devrelay\\logs\\agent.log',
    ENV,
  ).toString('utf8');
  assert.equal(hasNonAscii(text), false);
  assert.ok(!text.includes('chcp'));
  assert.equal(
    text,
    '@echo off\r\n"%APPDATA%\\devrelay\\node\\node.exe" "%APPDATA%\\devrelay\\agent\\agents\\linux\\dist\\index.js" >> "%APPDATA%\\devrelay\\logs\\agent.log" 2>&1\r\n',
  );
});

test('encodeCmd: 置き換えきれない日本語が残るときは chcp 65001 + UTF-8', () => {
  const text = buildClaudeWrapperCmd('D:\\ツール\\claude.exe', ENV).toString('utf8');
  assert.equal(text, '@echo off\r\nchcp 65001 >nul\r\n"D:\\ツール\\claude.exe" %*\r\n');
  assert.equal(encodeCmd(['echo a']).toString('utf8'), '@echo off\r\necho a\r\n');
});
