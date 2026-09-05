/**
 * Devin プランモードの「無言で途中終了」と `.svn` 洪水の解消（欠陥2対策）: `fs.watch` の
 * ライブファイル変更表示から SVN/Mercurial/Bazaar/CVS 等の VCS 作業コピー内部ファイルを
 * 除外する純関数群。
 *
 * `ai-runner.ts` の `fs.watch(projectPath, { recursive: true }, ...)` コールバック内に
 * インラインで書かれていた除外正規表現（`.git|node_modules|.devrelay|.devrelay-output|
 * dist|build|__pycache__|.next|target|vendor`）には `.svn` が無く、SVN 作業コピーでは
 * `.svn/pristine/**` の更新が全部通過してしまい、実測で 38 行以上の `⏳ 📝 .svn/pristine/...`
 * がチャットに流れる事故が起きた（Lafit 実測）。既存の「同一ファイル10秒スロットル」は
 * 別々のファイルが数百件ある pristine には無力、かつ全体上限も無かった。
 *
 * `devin-atif.ts`/`devin-diagnostics.ts`/`cli-failure.ts`/`session-scope.ts`/
 * `plan-permission.ts` と同じ流儀（外部 import ゼロ、3 OS byte-for-byte 同一、
 * `node:test` から直接 `dist/` を import してテストする）。
 */

/**
 * ノイズと判定して除外するディレクトリ名（VCS・依存・生成物・一時ディレクトリ）。
 * 既存の9種に加え `.svn`・`.hg`・`.bzr`・`CVS` を追加（欠陥2本体）。
 */
const NOISY_DIR_PATTERN = /(^|\/)(\.git|node_modules|\.devrelay|\.devrelay-output|dist|build|__pycache__|\.next|target|vendor|\.svn|\.hg|\.bzr|CVS)(\/|$)/;

/** ノイズと判定して除外する拡張子・一時ファイルパターン（既存どおり、変更なし） */
const NOISY_EXT_PATTERN = /~$|\.swp$|\.tmp$|\.log$|\.lock$/;

/**
 * ファイル変更ウォッチのターンあたり通知上限の既定値。
 * `DEVRELAY_DEVIN_FILEWATCH_MAX` 環境変数で呼び出し側が上書き可能（本モジュールは値を持つだけ）。
 */
export const DEFAULT_FILE_WATCH_NOTICE_LIMIT = 20;

/**
 * `fs.watch` が返す相対パスがチャットに出すべきでない「ノイズ」かどうかを判定する。
 * `\` 区切りの Windows パスも `/` に正規化してから判定する（呼び出し側で既に正規化済みでも安全）。
 * **例外を投げない。**
 * @param relPath `fs.watch` コールバックの `filename`（相対パス、`\`/`/` 区切り両対応）
 * @returns ノイズ（表示すべきでない）なら true
 */
export function isNoisyChangedPath(relPath: string): boolean {
  if (!relPath) return false;
  const f = relPath.replace(/\\/g, '/');
  if (NOISY_DIR_PATTERN.test(f)) return true;
  if (NOISY_EXT_PATTERN.test(f)) return true;
  return false;
}
