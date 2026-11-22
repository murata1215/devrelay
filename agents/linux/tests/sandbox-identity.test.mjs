import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCurrentUserSid, parseWhoamiUserCsv } from '../dist/services/sandbox-identity.js';

describe('sandbox-identity', () => {
  test('parseWhoamiUserCsv: 正常な CSV から SID を取り出す', () => {
    const sid = parseWhoamiUserCsv('"DESKTOP-ABC\\dev","S-1-5-21-111-222-333-1001"\r\n');
    assert.equal(sid, 'S-1-5-21-111-222-333-1001');
  });

  test('parseWhoamiUserCsv: 不正な形式は null', () => {
    assert.equal(parseWhoamiUserCsv('not a csv'), null);
    assert.equal(parseWhoamiUserCsv(''), null);
  });

  test('resolveCurrentUserSid: 注入した runner の結果をパースして返す', async () => {
    const sid = await resolveCurrentUserSid(async () => ({
      stdout: '"DESKTOP-ABC\\dev","S-1-5-21-111-222-333-1001"\r\n',
      stderr: '',
    }));
    assert.equal(sid, 'S-1-5-21-111-222-333-1001');
  });

  test('resolveCurrentUserSid: runner が例外を投げても null を返す（fail-closed、例外を伝播しない）', async () => {
    const sid = await resolveCurrentUserSid(async () => {
      throw new Error('whoami not found (non-Windows)');
    });
    assert.equal(sid, null);
  });

  test('resolveCurrentUserSid: runner が CSV 以外を返した場合も null（Linux の whoami 実行時相当）', async () => {
    const sid = await resolveCurrentUserSid(async () => ({ stdout: 'devuser\n', stderr: '' }));
    assert.equal(sid, null);
  });
});
