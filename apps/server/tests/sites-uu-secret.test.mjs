// DevRelay Sites Phase 1-B: uu-secret.ts の単体テスト。
// 実ファイルシステム（一時 HOME）を使い、生成・再利用・権限異常時の fail-soft を確認する。
// `UU_SECRET_PATH` は `homedir()` 起点で固定されているため、`HOME` 環境変数を差し替えて
// テスト用の一時ディレクトリに向ける（dist をテストプロセスごとに import し直す）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** `HOME` を切り替えた上で `uu-secret.js` を毎回フレッシュに import する（module top-level 定数を再評価させるため）。 */
async function freshModule(home) {
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // クエリ文字列でキャッシュバストして、UU_SECRET_PATH（homedir() を起動時に評価する top-level 定数）を再評価させる
    const mod = await import(`../dist/services/sites/uu-secret.js?home=${encodeURIComponent(home)}`);
    return mod;
  } finally {
    process.env.HOME = prevHome;
  }
}

test('初回生成: 0600 で作成され、以降は同値を再利用する', async () => {
  const home = await mkdtemp(join(tmpdir(), 'devrelay-uu-secret-'));
  try {
    const mod = await freshModule(home);
    const secretPath = mod.UU_SECRET_PATH;
    assert.equal(secretPath, join(home, '.devrelay', 'sites-uu-secret'));

    const first = await mod.getOrCreateUuSecret();
    assert.equal(first.ok, true);
    assert.equal(first.secret.length, 64);
    assert.match(first.secret, /^[0-9a-f]{64}$/);

    const st = await stat(secretPath);
    assert.equal(st.mode & 0o777, 0o600);

    // 2 回目は同じ secret を再利用する（新規生成しない）
    const second = await mod.getOrCreateUuSecret();
    assert.equal(second.ok, true);
    assert.equal(second.secret, first.secret);

    // ファイル内容もそのまま
    const content = (await readFile(secretPath, 'utf-8')).trim();
    assert.equal(content, first.secret);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('権限異常（0644）: UU unavailable になり、secret 本体はエラーに出ない', async () => {
  const home = await mkdtemp(join(tmpdir(), 'devrelay-uu-secret-'));
  try {
    const mod = await freshModule(home);
    const first = await mod.getOrCreateUuSecret();
    assert.equal(first.ok, true);

    await chmod(mod.UU_SECRET_PATH, 0o644);

    const second = await mod.getOrCreateUuSecret();
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'permission_mismatch');
    // reason は enum のみ。エラーオブジェクトのどのフィールドにも secret 本体（64 桁 hex）が含まれない。
    assert.equal(JSON.stringify(second).includes(first.secret), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('内容不正（長さが違う）: length_invalid で UU unavailable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'devrelay-uu-secret-'));
  try {
    const mod = await freshModule(home);
    const first = await mod.getOrCreateUuSecret();
    assert.equal(first.ok, true);

    const { writeFile } = await import('node:fs/promises');
    await writeFile(mod.UU_SECRET_PATH, 'not-a-valid-hex-secret', { mode: 0o600 });

    const second = await mod.getOrCreateUuSecret();
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'length_invalid');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
