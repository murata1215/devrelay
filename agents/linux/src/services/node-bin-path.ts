/**
 * Agent 自身を起動している node の bin ディレクトリを PATH に冪等に前置するための純関数群。
 *
 * 背景（2026-10-26 `spawn codex ENOENT` 障害の根治）:
 * nvm 等でグローバルインストールした AI CLI（codex 等）は `~/.nvm/versions/node/<ver>/bin`
 * のような、その node バージョン専用の bin にしか存在しない。Agent が
 * - `@reboot` crontab（cron の PATH は最小構成）
 * - `u` 自己更新後の nohup 再起動
 * のいずれで起動しても、**Agent 自身を実行している node（`process.execPath`）の bin ディレクトリ**
 * を PATH に入れておけば、同じ nvm 環境に入れた CLI は常に見える。
 *
 * 旧実装（`connection.ts` の `u` 再起動）は Windows ポータブル node 想定の固定パス
 * `~/.devrelay/node/bin` を毎回 `export PATH="${nodeBinDir}:$PATH"` として前置しており、
 * (1) この機体には存在しないディレクトリを無条件に積んでいた (2) 冪等でないため `u` を
 * 実行するたびに同じ値が重複して積み上がっていた（2026-10-18 の crontab `;;` 増殖事故と同型）。
 * 本モジュールはその両方を直す: 存在しない dir は追加せず、既に含まれる dir は追加しない。
 *
 * 外部 import ゼロに保つ（`crontab-fix-rules.ts` / `service-path-rules.ts` / `ai-tool-presence.ts`
 * と同じ流儀）。コンパイル済み dist を `node --test` から直接 import して単体検証できる。
 * `agents/macos` は本ファイルと byte-identical。
 */

/**
 * PATH 文字列に `dir` を冪等に前置する。
 * - `dir` が空文字、または `exists(dir)` が false（存在しない）→ `pathValue` をそのまま返す
 * - `pathValue` を `sep` で分割した中に既に `dir` が含まれる → 前置せずそのまま返す（重複防止）
 * - それ以外 → `dir + sep + pathValue`（`pathValue` が空/undefined なら `dir` のみ）
 * @param pathValue 現在の PATH 値（`process.env.PATH`）
 * @param dir 前置したいディレクトリ（存在判定込み）
 * @param sep PATH のセパレータ（Windows は `;`、それ以外は `:`）
 * @param exists ディレクトリ存在判定関数（`fs.existsSync` 等。テスト時に差し替え可能にするため注入）
 */
export function prependBinDir(
  pathValue: string | undefined,
  dir: string,
  sep: string,
  exists: (p: string) => boolean,
): string {
  const current = pathValue ?? '';
  if (!dir || !exists(dir)) return current;
  const entries = current.length > 0 ? current.split(sep) : [];
  if (entries.includes(dir)) return current;
  return current.length > 0 ? `${dir}${sep}${current}` : dir;
}
