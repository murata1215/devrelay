/**
 * サイクルS2a（2026-11-12）: クロス ask スコープのパス実体判定（fs を要するため
 * `cross-ask-scope-rules.ts`（外部 import ゼロ規約）から分離する。`scope-dir.ts` が
 * `session-scope.ts` から `path` 処理を分離しているのと同じ理由（同ファイル JSDoc 参照）。
 *
 * realpath（実体パス）で判定することで、プロジェクト外を指すシンボリックリンク・`..`・`~`・
 * 環境変数展開を一括で無効化する（Plan フェーズで列挙した抜け道①）。加えて、パス構成要素の
 * いずれかがシンボリックリンクであれば無条件で deny する（defense-in-depth。realpath による
 * 境界判定だけで「シンボリックリンク越しにプロジェクト外を指す」は防げるが、TOCTOU
 * （判定後にリンク先を差し替える）への追加防御。本サイクルではクロス ask は Bash/Write/Edit を
 * 全 deny するため、攻撃者がセッション中にリンクを作成・差し替える手段自体が無く実害は限定的だが、
 * 事前に仕込まれたリンクへの保険として残す）。
 */

import fs from 'fs';
import path from 'path';
import { isDeniedProjectRelativePath } from './cross-ask-scope-rules.js';

/** `checkCrossAskPath()` の判定結果。 */
export type CrossAskPathCheckResult =
  | { allowed: true }
  | { allowed: false; reason: 'outsideProject' | 'symlink' | 'deniedPath' };

/**
 * パス構成要素（`root` 配下の各ディレクトリ階層）にシンボリックリンクが含まれるかを判定する。
 * 存在しない中間セグメントは無視する（lstat が ENOENT の場合は false 扱い、無限ループしない
 * よう `dirname` が変化しなくなったら停止する）。
 */
function hasSymlinkComponent(root: string, absPath: string): boolean {
  let current = absPath;
  while (current.length >= root.length && current.startsWith(root)) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    } catch {
      // 存在しないセグメントは無視（新規作成対象の親ディレクトリ等）
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

/**
 * プロジェクトルートの realpath を解決する。存在しない場合は構文的な正規化のみ行う
 * （プロジェクトディレクトリは通常存在するはずだが、fail-closed のため例外時も動作を継続する）。
 */
export function resolveProjectRootReal(projectPath: string): string {
  try {
    return fs.realpathSync(projectPath);
  } catch {
    return path.resolve(projectPath);
  }
}

/**
 * Read/Grep/Glob の `file_path`/`path` 引数が、`projectRootReal`（事前に realpath 済み）配下の
 * 読んでよいパスかどうかを判定する。
 *
 * 判定順: ① 絶対パス化（相対はプロジェクトルート基準で解決） ② realpath 解決（存在しなければ
 * 構文正規化のみ） ③ プロジェクトルート配下かを境界判定（`path.sep` 境界で接頭辞事故を回避）
 * ④ パス構成要素にシンボリックリンクが無いか ⑤ プロジェクト相対パスが既定の deny 一覧に当たらないか
 *
 * @param projectRootReal `resolveProjectRootReal()` で事前に解決したプロジェクトルート
 * @param rawValue ツール入力の `file_path`/`path` の値（絶対・相対どちらでも受け付ける）
 */
export function checkCrossAskPath(projectRootReal: string, rawValue: string): CrossAskPathCheckResult {
  const absCandidate = path.isAbsolute(rawValue) ? rawValue : path.resolve(projectRootReal, rawValue);

  let real: string;
  try {
    real = fs.realpathSync(absCandidate);
  } catch {
    real = path.normalize(absCandidate);
  }

  const inside = real === projectRootReal || real.startsWith(projectRootReal + path.sep);
  if (!inside) {
    return { allowed: false, reason: 'outsideProject' };
  }

  if (hasSymlinkComponent(projectRootReal, absCandidate)) {
    return { allowed: false, reason: 'symlink' };
  }

  const relPosix = path.relative(projectRootReal, real).split(path.sep).join('/');
  if (isDeniedProjectRelativePath(relPosix)) {
    return { allowed: false, reason: 'deniedPath' };
  }

  return { allowed: true };
}
