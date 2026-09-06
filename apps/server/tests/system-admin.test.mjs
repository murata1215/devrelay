// #367: システム管理者判定（apps/server/src/services/system-admin.ts）の単体テスト。
// 外部 import ゼロの純粋関数をコンパイル済み dist から直接 import する
// （#308/#331/#332/#348 と同じ流儀）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSystemAdminEmails,
  isSystemAdminEmail,
  requireSystemAdmin,
} from '../dist/services/system-admin.js';

// --- parseSystemAdminEmails ---

test('parseSystemAdminEmails: undefined は空配列', () => {
  assert.deepEqual(parseSystemAdminEmails(undefined), []);
});

test('parseSystemAdminEmails: 空文字列は空配列', () => {
  assert.deepEqual(parseSystemAdminEmails(''), []);
});

test('parseSystemAdminEmails: カンマのみは空配列', () => {
  assert.deepEqual(parseSystemAdminEmails(',,,'), []);
});

test('parseSystemAdminEmails: 1件をパース', () => {
  assert.deepEqual(parseSystemAdminEmails('admin@example.com'), ['admin@example.com']);
});

test('parseSystemAdminEmails: 複数件をカンマ区切りでパース', () => {
  assert.deepEqual(
    parseSystemAdminEmails('a@example.com,b@example.com'),
    ['a@example.com', 'b@example.com']
  );
});

test('parseSystemAdminEmails: 前後の空白を除去する', () => {
  assert.deepEqual(
    parseSystemAdminEmails(' a@example.com , b@example.com '),
    ['a@example.com', 'b@example.com']
  );
});

test('parseSystemAdminEmails: 小文字化する', () => {
  assert.deepEqual(parseSystemAdminEmails('Admin@Example.COM'), ['admin@example.com']);
});

test('parseSystemAdminEmails: 空要素を除去する（末尾カンマ等）', () => {
  assert.deepEqual(parseSystemAdminEmails('a@example.com,'), ['a@example.com']);
});

// --- isSystemAdminEmail ---

test('isSystemAdminEmail: 【最重要】allowlist が空配列なら常に false（fail-closed）', () => {
  assert.equal(isSystemAdminEmail('anyone@example.com', []), false);
});

test('isSystemAdminEmail: allowlist が空配列なら null/undefined でも false', () => {
  assert.equal(isSystemAdminEmail(null, []), false);
  assert.equal(isSystemAdminEmail(undefined, []), false);
});

test('isSystemAdminEmail: email が null/undefined なら allowlist 非空でも false', () => {
  assert.equal(isSystemAdminEmail(null, ['admin@example.com']), false);
  assert.equal(isSystemAdminEmail(undefined, ['admin@example.com']), false);
});

test('isSystemAdminEmail: email が空文字列・空白のみなら false', () => {
  assert.equal(isSystemAdminEmail('', ['admin@example.com']), false);
  assert.equal(isSystemAdminEmail('   ', ['admin@example.com']), false);
});

test('isSystemAdminEmail: allowlist に一致すれば true', () => {
  assert.equal(isSystemAdminEmail('admin@example.com', ['admin@example.com']), true);
});

test('isSystemAdminEmail: 大文字小文字を無視して一致する', () => {
  assert.equal(isSystemAdminEmail('Admin@Example.com', ['admin@example.com']), true);
});

test('isSystemAdminEmail: 前後の空白を無視して一致する', () => {
  assert.equal(isSystemAdminEmail('  admin@example.com  ', ['admin@example.com']), true);
});

test('isSystemAdminEmail: allowlist に含まれないメールは false', () => {
  assert.equal(isSystemAdminEmail('notadmin@example.com', ['admin@example.com']), false);
});

test('isSystemAdminEmail: 部分一致では一致しない（前方一致の誤爆防止）', () => {
  assert.equal(isSystemAdminEmail('notadmin@x.com', ['admin@x.com']), false);
});

test('isSystemAdminEmail: 複数件の allowlist から正しく判定する', () => {
  const allowlist = ['a@example.com', 'b@example.com'];
  assert.equal(isSystemAdminEmail('b@example.com', allowlist), true);
  assert.equal(isSystemAdminEmail('c@example.com', allowlist), false);
});

// --- requireSystemAdmin ---

function createMockReply() {
  const calls = { status: null, body: null };
  return {
    reply: {
      status(code) {
        calls.status = code;
        return {
          send(body) {
            calls.body = body;
            return undefined;
          },
        };
      },
    },
    calls,
  };
}

test('requireSystemAdmin: allowlist 未設定（fail-closed）なら管理者メールでも 403 で false', () => {
  delete process.env.DEVRELAY_SYSTEM_ADMIN_EMAILS;
  const { reply, calls } = createMockReply();
  const result = requireSystemAdmin({ user: { email: 'admin@example.com' } }, reply);
  assert.equal(result, false);
  assert.equal(calls.status, 403);
  assert.deepEqual(calls.body, { error: 'システム管理者権限が必要です' });
});

test('requireSystemAdmin: allowlist 設定済みで一致すれば true・reply 未使用', () => {
  process.env.DEVRELAY_SYSTEM_ADMIN_EMAILS = 'admin@example.com';
  const { reply, calls } = createMockReply();
  const result = requireSystemAdmin({ user: { email: 'admin@example.com' } }, reply);
  assert.equal(result, true);
  assert.equal(calls.status, null, '許可時は reply.status を呼ばない');
  delete process.env.DEVRELAY_SYSTEM_ADMIN_EMAILS;
});

test('requireSystemAdmin: allowlist 設定済みだが一致しないメールは 403 で false', () => {
  process.env.DEVRELAY_SYSTEM_ADMIN_EMAILS = 'admin@example.com';
  const { reply, calls } = createMockReply();
  const result = requireSystemAdmin({ user: { email: 'other@example.com' } }, reply);
  assert.equal(result, false);
  assert.equal(calls.status, 403);
  delete process.env.DEVRELAY_SYSTEM_ADMIN_EMAILS;
});

test('requireSystemAdmin: request.user が無い（未認証相当）場合は 403 で false', () => {
  process.env.DEVRELAY_SYSTEM_ADMIN_EMAILS = 'admin@example.com';
  const { reply, calls } = createMockReply();
  const result = requireSystemAdmin({}, reply);
  assert.equal(result, false);
  assert.equal(calls.status, 403);
  delete process.env.DEVRELAY_SYSTEM_ADMIN_EMAILS;
});
