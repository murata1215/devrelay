/**
 * DevRelay Sites Phase 1-B — UU（ユニークユーザー）ハッシュ用 secret の管理。
 *
 * `/home/devrelay/.devrelay/sites-uu-secret` に固定ファイルとして自動生成する（決定2）。
 * `.env` への追加はしない。secret 本体はログ・API・エラーメッセージに一切出さない。
 * 読み込み・生成のいずれかで失敗した場合は fail-soft：UU は unavailable（`stats.uu = null`）に
 * なるが、PV 等の他の集計は継続する（呼び出し側 `access-aggregator.ts` の責務）。
 */

import { randomBytes } from 'crypto';
import { readFile, writeFile, mkdir, stat as fsStat } from 'fs/promises';
import { homedir } from 'os';
import { join, dirname } from 'path';

export const UU_SECRET_PATH = join(homedir(), '.devrelay', 'sites-uu-secret');

const EXPECTED_HEX_LENGTH = 64; // randomBytes(32).toString('hex')

/** secret 取得結果。失敗理由は enum のみ（secret 本体・生の I/O エラー文字列は含めない）。 */
export type UuSecretUnavailableReason = 'read_failed' | 'write_failed' | 'permission_mismatch' | 'length_invalid';

export type UuSecretResult = { ok: true; secret: string } | { ok: false; reason: UuSecretUnavailableReason };

/**
 * secret ファイルを検証する（uid が自分自身か、group/other に権限が漏れていないか）。
 * `fstat` ベースで確認し、不一致なら permission_mismatch として弾く。
 */
function isModeSafe(mode: number): boolean {
  return (mode & 0o077) === 0;
}

/**
 * secret を取得する。無ければ `randomBytes(32).toString('hex')` を排他作成（`flag: 'wx'`）する。
 * 複数プロセスが同時に初回起動しても `EEXIST` で既存値へ収束するため、単一の secret になる。
 */
export async function getOrCreateUuSecret(): Promise<UuSecretResult> {
  // 1. 既存ファイルを読む
  const existing = await tryReadSecret();
  if (existing) return existing;
  if (existing === false) {
    // 権限異常など「読めるが使えない」状態は生成を試みずそのまま unavailable
    return { ok: false, reason: 'permission_mismatch' };
  }

  // 2. 存在しない場合のみ新規生成（排他作成）
  // 親ディレクトリ（`~/.devrelay`）は通常 config.yaml 用に既存（0775 devrelay:devrelay）だが、
  // 存在しない環境（テスト等）でも動くよう念のため作成しておく。
  await mkdir(dirname(UU_SECRET_PATH), { recursive: true }).catch(() => undefined);
  const hex = randomBytes(32).toString('hex');
  try {
    await writeFile(UU_SECRET_PATH, hex, { mode: 0o600, flag: 'wx' });
    return { ok: true, secret: hex };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EEXIST') {
      // 競合: 他プロセスが先に作った → それを読む
      const raceResult = await tryReadSecret();
      if (raceResult) return raceResult;
      return { ok: false, reason: raceResult === false ? 'permission_mismatch' : 'read_failed' };
    }
    return { ok: false, reason: 'write_failed' };
  }
}

/**
 * 既存 secret ファイルを読んで検証する。
 * 戻り値: 成功時 `UuSecretResult`、ファイルが存在しない場合 `null`、
 * 存在するが権限/内容が不正な場合 `false`（呼び出し側で permission_mismatch として扱う）。
 */
async function tryReadSecret(): Promise<UuSecretResult | null | false> {
  try {
    const [content, stat] = await Promise.all([readFile(UU_SECRET_PATH, 'utf-8'), statSecret()]);
    if (!stat) return false;
    if (stat.uid !== process.getuid?.()) return false;
    if (!isModeSafe(stat.mode)) return false;
    const trimmed = content.trim();
    if (trimmed.length !== EXPECTED_HEX_LENGTH || !/^[0-9a-f]+$/.test(trimmed)) {
      return { ok: false, reason: 'length_invalid' };
    }
    return { ok: true, secret: trimmed };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return null;
    return false;
  }
}

async function statSecret(): Promise<{ uid: number; mode: number } | null> {
  try {
    const st = await fsStat(UU_SECRET_PATH);
    return { uid: st.uid, mode: st.mode };
  } catch {
    return null;
  }
}
