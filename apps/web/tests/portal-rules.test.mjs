// ポータル（/portal）用純関数のテスト。
// ログイン後の戻り先（?next=）がオープンリダイレクトにならないこと、
// portal.json が壊れていても例外を出さず安全な値だけ拾うことを固定する。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeNextPath,
  buildLoginPath,
  resolvePortalFileHref,
  normalizePortalConfig,
  DEFAULT_PORTAL_CONFIG,
} from '../dist-test/lib/portal-rules.js';

const BASE = '/tsinternal/devrelay/';

test('sanitizeNextPath: 内部パスは通す', () => {
  assert.equal(sanitizeNextPath('/knowledge'), '/knowledge');
  assert.equal(sanitizeNextPath('/chat?x=1'), '/chat?x=1');
  assert.equal(sanitizeNextPath('/'), '/');
});

test('sanitizeNextPath: 外部・不正・ループは拒否', () => {
  for (const bad of [null, undefined, '', 'manager', 'knowledge', '//evil.com', '/\\evil.com',
    'https://evil.com', 'javascript:alert(1)', '/a\nb', '/login', '/login?next=/x', '/register', '/portal', '/auth/callback?token=x']) {
    assert.equal(sanitizeNextPath(bad), null, String(bad));
  }
  assert.equal(sanitizeNextPath('/portalx'), '/portalx');
});

test('buildLoginPath', () => {
  assert.equal(buildLoginPath('/knowledge'), '/login?next=%2Fknowledge');
  assert.equal(buildLoginPath('/'), '/login');
  assert.equal(buildLoginPath('//evil.com'), '/login');
});

test('resolvePortalFileHref: ファイル名は portal-files 配下に解決', () => {
  assert.equal(resolvePortalFileHref('manual.pdf', BASE), '/tsinternal/devrelay/portal-files/manual.pdf');
  assert.equal(resolvePortalFileHref('docs/使い方.pdf', '/'), '/portal-files/docs/%E4%BD%BF%E3%81%84%E6%96%B9.pdf');
  assert.equal(resolvePortalFileHref('https://example.com/a.pdf', BASE), 'https://example.com/a.pdf');
});

test('resolvePortalFileHref: トラバーサル・スキームは拒否', () => {
  for (const bad of ['', '../web.config', 'a/../../x', '/etc/passwd', 'a\\b.pdf', 'javascript:alert(1)', 'file:///c:/x']) {
    assert.equal(resolvePortalFileHref(bad, BASE), null, bad);
  }
});

test('normalizePortalConfig: 壊れた入力は既定値', () => {
  assert.deepEqual(normalizePortalConfig(null, BASE), DEFAULT_PORTAL_CONFIG);
  assert.deepEqual(normalizePortalConfig('x', BASE), DEFAULT_PORTAL_CONFIG);
  assert.deepEqual(normalizePortalConfig([], BASE), DEFAULT_PORTAL_CONFIG);
});

test('normalizePortalConfig: 正常系と不正項目の除外', () => {
  const c = normalizePortalConfig({
    title: '社内 DevRelay',
    notices: [{ date: '2026-11-11', text: 'ポータル公開' }, { text: '' }, 'x'],
    manuals: [
      { title: 'コマンド', file: 'command.pdf', description: 'd' },
      { title: '悪い', file: '../web.config' },
      { file: 'notitle.pdf' },
    ],
    links: [
      { title: 'ナレッジ', href: '/knowledge' },
      { title: '社内Wiki', href: 'https://wiki.example.com' },
      { title: 'bad', href: 'javascript:alert(1)' },
      { title: 'bad2', href: '//evil.com' },
    ],
    installSteps: [],
  }, BASE);
  assert.equal(c.title, '社内 DevRelay');
  assert.equal(c.subtitle, DEFAULT_PORTAL_CONFIG.subtitle);
  assert.deepEqual(c.notices, [{ date: '2026-11-11', text: 'ポータル公開' }]);
  assert.deepEqual(c.manuals, [{ title: 'コマンド', description: 'd', href: '/tsinternal/devrelay/portal-files/command.pdf' }]);
  assert.deepEqual(c.links.map((l) => [l.href, l.internal]), [['/knowledge', true], ['https://wiki.example.com', false]]);
  assert.deepEqual(c.installSteps, DEFAULT_PORTAL_CONFIG.installSteps);
});
