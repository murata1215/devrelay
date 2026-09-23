/**
 * DevRelay Sites Phase 1-A — `ss` / `ps` / `/etc/passwd` / `/proc` による
 * root 不要のプロセス・ソケット情報の読み取り専用プローブ。
 *
 * sudo は一切使わない。すべて `execFile`（シェルを経由しない）+ timeout 3s。
 * パーサ本体（`parseSsListen` 等）は I/O ゼロの純粋関数としてテスト可能にする。
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, readlink } from 'fs/promises';
import type { CgroupHint, ListenInfo, ProcessHint } from './types.js';

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT_MS = 3000;
const MAX_BUFFER = 1024 * 1024; // 1MB 上限

/** `ss -Hltne` の 1 行から LISTEN 情報を抽出する（純粋関数）。
 * 実機出力例:
 *   LISTEN 0      2048       127.0.0.1:9023 0.0.0.0:* uid:1012 ino:8555363 sk:100e cgroup:/user.slice/.../dangou-viewer.service <->
 */
export function parseSsListen(text: string): ListenInfo[] {
  const results: ListenInfo[] = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('LISTEN')) continue;
    const fields = trimmed.split(/\s+/);
    if (fields.length < 4) continue;
    const localAddr = fields[3]; // 例: '127.0.0.1:9023' / '0.0.0.0:9010' / '[::]:9010' / '127.0.0.53%lo:53'
    const portIdx = localAddr.lastIndexOf(':');
    if (portIdx === -1) continue;
    const port = Number(localAddr.slice(portIdx + 1));
    if (!Number.isInteger(port) || port <= 0) continue;
    const bind = localAddr.slice(0, portIdx);

    let uid: number | null = null;
    let cgroup: string | null = null;
    for (const field of fields.slice(4)) {
      if (field.startsWith('uid:')) {
        const parsed = Number(field.slice(4));
        if (Number.isInteger(parsed)) uid = parsed;
      } else if (field.startsWith('cgroup:')) {
        cgroup = field.slice('cgroup:'.length);
      }
    }
    if (uid === null) continue;
    results.push({ port, bind, uid, cgroup });
  }
  return results;
}

/** cgroup パス文字列から末端セグメントを取り出し、PM2 の共通ラッパーかどうかを判定する。 */
export function parseCgroupHint(cgroup: string | null): CgroupHint | null {
  if (!cgroup) return null;
  const segments = cgroup.split('/').filter((s) => s.length > 0);
  const lastSegment = segments.length > 0 ? segments[segments.length - 1] : null;
  const isPm2Wrapper = lastSegment !== null && /^pm2-.*\.service$/.test(lastSegment);
  return { raw: cgroup, lastSegment, isPm2Wrapper };
}

/** `/etc/passwd` をパースし uid → username の Map を作る（純粋関数）。 */
export function parsePasswd(text: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(':');
    if (parts.length < 3) continue;
    const uid = Number(parts[2]);
    if (Number.isInteger(uid)) map.set(uid, parts[0]);
  }
  return map;
}

/** `ss -Hltnp`（devrelay 自身が所有するソケットのみ pid が付く）から port → pid を抽出する。
 * 例: `LISTEN 0 511 0.0.0.0:9010 0.0.0.0:* users:(("node",pid=3644996,fd=21))`
 */
export function parseSsWithPid(text: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('LISTEN')) continue;
    const fields = trimmed.split(/\s+/);
    if (fields.length < 4) continue;
    const localAddr = fields[3];
    const portIdx = localAddr.lastIndexOf(':');
    if (portIdx === -1) continue;
    const port = Number(localAddr.slice(portIdx + 1));
    if (!Number.isInteger(port) || port <= 0) continue;
    const pidMatch = trimmed.match(/pid=(\d+)/);
    if (pidMatch) map.set(port, Number(pidMatch[1]));
  }
  return map;
}

/**
 * `ps -eo user,pid,args` の全行から、指定ポートに関連しそうな行を推測してヒントを返す。
 * `--port N` / `-p N` / `:N` / `PORT=N` のいずれかを args に含む行のみ対象。
 * 複数マッチした場合は全件返す（呼び出し側で最初のものを採用する）。
 */
export function parsePsArgsForPort(text: string, port: number): ProcessHint[] {
  const results: ProcessHint[] = [];
  const patterns = [
    new RegExp(`--port[= ]${port}\\b`),
    new RegExp(`-p[= ]${port}\\b`),
    new RegExp(`:${port}\\b`),
    new RegExp(`PORT=${port}\\b`),
  ];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\S+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const [, user, pidStr, args] = match;
    if (patterns.some((re) => re.test(args))) {
      results.push({ pid: Number(pidStr), user, args: args.slice(0, 200) });
    }
  }
  return results;
}

/** すべての `ss -Hltne` LISTEN 行を取得する（root 不要）。失敗時は空配列で縮退。 */
export async function getListenInfo(): Promise<{ listens: ListenInfo[]; available: boolean }> {
  try {
    const { stdout } = await execFileAsync('ss', ['-Hltne'], {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    return { listens: parseSsListen(stdout), available: true };
  } catch {
    return { listens: [], available: false };
  }
}

/** 自ユーザー（devrelay）が所有するソケットの port→pid を取得する。失敗時は空 Map。 */
export async function getListenPids(): Promise<Map<number, number>> {
  try {
    const { stdout } = await execFileAsync('ss', ['-Hltnp'], {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    return parseSsWithPid(stdout);
  } catch {
    return new Map();
  }
}

/** `/etc/passwd` を読んで uid→username の Map を返す。失敗時は空 Map。 */
export async function getUidUserMap(): Promise<Map<number, string>> {
  try {
    const text = await readFile('/etc/passwd', 'utf-8');
    return parsePasswd(text);
  } catch {
    return new Map();
  }
}

/** 全プロセスの `user pid args` テキストを取得する。失敗時は空文字列。 */
export async function getPsArgsText(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'user,pid,args', '--no-headers'], {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch {
    return '';
  }
}

/** `/proc/<pid>/cwd` を readlink する（自ユーザーのプロセスのみ成功する）。失敗時は null。 */
export async function getProcessCwd(pid: number): Promise<string | null> {
  try {
    return await readlink(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

/** `/proc/<pid>/cmdline`（NUL 区切り）を読み、スペース区切りの表示用文字列にする。失敗時は null。 */
export async function getProcessCmdline(pid: number): Promise<string | null> {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, 'utf-8');
    const parts = raw.split('\0').filter((s) => s.length > 0);
    return parts.length > 0 ? parts.join(' ').slice(0, 300) : null;
  } catch {
    return null;
  }
}
