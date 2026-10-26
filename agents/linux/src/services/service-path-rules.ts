/**
 * systemd user service の `Environment=PATH=` に使う値を組み立てる純粋関数。
 *
 * 背景（2026-10-18 障害で発見した本体バグ2件目）: systemd unit を書く経路が2つあり
 * （`scripts/install-agent.sh:638-649, 768-782` と `agents/linux/src/cli/commands/setup.ts`
 * の `installUserService()`）、テンプレートが乖離していた。`install-agent.sh` 側は
 * `Environment=PATH=` を明示しているが、`setup.ts` 側は `Environment=NODE_ENV=production`
 * だけで PATH を書いていなかった。systemd user service は `.bashrc` を読まないため、
 * PATH 行が無いと `which` ベースの AI ツール検出（`detectAndUpdateAiTools()`）が
 * systemd の既定 PATH（`~/.local/bin` 等を含まない）で失敗する実害があった
 * （`devrelay setup` 経由で作られた `pixblog` の unit で実際に発生）。
 *
 * この関数で両経路の PATH 組み立てを一致させる。
 */

import { dirname, join } from 'path';

/**
 * `scripts/install-agent.sh:638-649` の `SERVICE_PATH` 組み立てと同一の規約で
 * systemd user service 用の PATH 文字列を返す。
 *
 * @param home ホームディレクトリ（`os.homedir()` の値）
 * @param binDir devrelay-claude ラッパー格納ディレクトリ（`getBinDir()` の値）
 * @param nodeExecPath 現在実行中の node の絶対パス（`process.execPath`）
 * @param hasLocalBin `~/.local/bin` が存在するか（存在確認は呼び出し側が行う。
 *   claude CLI の一般的なインストール先のため、存在する場合のみ PATH に含める）
 * @returns `:` 区切りの PATH 文字列
 */
export function buildServicePath(
  home: string,
  binDir: string,
  nodeExecPath: string,
  hasLocalBin: boolean,
): string {
  const nodeBinDir = dirname(nodeExecPath);
  const parts: string[] = [nodeBinDir, '/usr/local/bin', '/usr/bin', '/bin'];
  if (hasLocalBin) {
    parts.unshift(join(home, '.local', 'bin'));
  }
  parts.unshift(binDir);
  return parts.join(':');
}
