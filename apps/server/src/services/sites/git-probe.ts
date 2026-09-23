/**
 * DevRelay Sites Phase 1-A — Git 情報の読み取り専用プローブ。
 * devrelay ユーザーが読める `.git` を持つディレクトリのみ動作する（他ユーザーの
 * home 配下は権限で弾かれ、静かに null を返す）。書き込み系コマンドは一切呼ばない。
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { access } from 'fs/promises';
import { join } from 'path';
import type { GitInfo } from './types.js';

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT_MS = 3000;

/** 指定ディレクトリに `.git` があり読めるかどうかを確認する。 */
export async function hasReadableGit(dir: string): Promise<boolean> {
  try {
    await access(join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/** 指定ディレクトリの Git 情報（branch/HEAD/remote）を取得する。読めない場合は全 null。 */
export async function getGitInfo(dir: string): Promise<GitInfo> {
  if (!(await hasReadableGit(dir))) {
    return { branch: null, head: null, remote: null };
  }
  const run = async (args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync('git', ['-C', dir, ...args], { timeout: EXEC_TIMEOUT_MS });
      const trimmed = stdout.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  };
  const [branch, head, remote] = await Promise.all([
    run(['rev-parse', '--abbrev-ref', 'HEAD']),
    run(['rev-parse', '--short', 'HEAD']),
    run(['remote', 'get-url', 'origin']),
  ]);
  return { branch, head, remote };
}
