import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateProjectOwnership,
  evaluateSessionOwnership,
  evaluateThreadCreate,
  evaluateThreadSwitch,
} from '../dist/services/thread-api-guard.js';

describe('evaluateProjectOwnership', () => {
  test('project が null なら 404', () => {
    const result = evaluateProjectOwnership({ project: null, requestUserId: 'u1' });
    assert.deepEqual(result, { ok: false, status: 404, error: 'Project not found' });
  });

  test('machine.userId が一致しなければ 404（403 ではない）', () => {
    const result = evaluateProjectOwnership({
      project: { machine: { userId: 'other-user' } },
      requestUserId: 'u1',
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
  });

  test('machine.userId が一致すれば ok', () => {
    const result = evaluateProjectOwnership({
      project: { machine: { userId: 'u1' } },
      requestUserId: 'u1',
    });
    assert.deepEqual(result, { ok: true });
  });
});

describe('evaluateSessionOwnership', () => {
  test('session が null なら 404', () => {
    const result = evaluateSessionOwnership({ session: null, requestUserId: 'u1' });
    assert.deepEqual(result, { ok: false, status: 404, error: 'Session not found' });
  });

  test('session.userId が一致しなければ 404', () => {
    const result = evaluateSessionOwnership({
      session: { userId: 'other-user' },
      requestUserId: 'u1',
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
  });

  test('session.userId が一致すれば ok', () => {
    const result = evaluateSessionOwnership({
      session: { userId: 'u1' },
      requestUserId: 'u1',
    });
    assert.deepEqual(result, { ok: true });
  });
});

describe('evaluateThreadCreate（POST /api/threads）', () => {
  test('project が null なら 404', () => {
    const result = evaluateThreadCreate({ project: null, requestUserId: 'u1', machineOnline: true });
    assert.deepEqual(result, { ok: false, status: 404, error: 'Project not found' });
  });

  test('他人のプロジェクトなら 404', () => {
    const result = evaluateThreadCreate({
      project: { machine: { userId: 'other' } },
      requestUserId: 'u1',
      machineOnline: true,
    });
    assert.equal(result.status, 404);
  });

  test('所有者一致だがマシンオフラインなら 409', () => {
    const result = evaluateThreadCreate({
      project: { machine: { userId: 'u1' } },
      requestUserId: 'u1',
      machineOnline: false,
    });
    assert.deepEqual(result, { ok: false, status: 409, error: 'Machine is offline' });
  });

  test('所有者一致かつオンラインなら ok', () => {
    const result = evaluateThreadCreate({
      project: { machine: { userId: 'u1' } },
      requestUserId: 'u1',
      machineOnline: true,
    });
    assert.deepEqual(result, { ok: true });
  });

  test('所有者不一致がオフライン判定より優先される（404 が先）', () => {
    const result = evaluateThreadCreate({
      project: { machine: { userId: 'other' } },
      requestUserId: 'u1',
      machineOnline: false,
    });
    assert.equal(result.status, 404);
  });
});

describe('evaluateThreadSwitch（POST /api/sessions/:id/switch）', () => {
  test('tabId 欠落は 400（所有者チェックより先に判定される）', () => {
    const result = evaluateThreadSwitch({
      tabId: null,
      session: { userId: 'other' }, // 他人のセッションでも tabId チェックが先
      requestUserId: 'u1',
    });
    assert.deepEqual(result, { ok: false, status: 400, error: 'tabId is required' });
  });

  test('tabId が空文字も 400', () => {
    const result = evaluateThreadSwitch({ tabId: '', session: { userId: 'u1' }, requestUserId: 'u1' });
    assert.equal(result.status, 400);
  });

  test('tabId ありで他人の Session は 404', () => {
    const result = evaluateThreadSwitch({
      tabId: 'tab1',
      session: { userId: 'other' },
      requestUserId: 'u1',
    });
    assert.deepEqual(result, { ok: false, status: 404, error: 'Session not found' });
  });

  test('tabId ありで存在しない Session（null）も 404', () => {
    const result = evaluateThreadSwitch({ tabId: 'tab1', session: null, requestUserId: 'u1' });
    assert.equal(result.status, 404);
  });

  test('tabId ありで所有者一致なら ok', () => {
    const result = evaluateThreadSwitch({
      tabId: 'tab1',
      session: { userId: 'u1' },
      requestUserId: 'u1',
    });
    assert.deepEqual(result, { ok: true });
  });
});
