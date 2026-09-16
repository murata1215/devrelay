/**
 * Agents ページ（MachinesPage.tsx）の表示ロジックのうち、DB/Agent 由来の未検証な値を安全に
 * 表示用の形へ変換する純関数群（外部 import ゼロ。node:test から dist-test/ を直接 import する、
 * capability-config-rules.ts / panel-resize-rules.ts と同じ流儀）。
 *
 * 背景: `Machine.managementInfo` は Agent が接続時に送ってきた JSON を Server が一切検証せず
 * そのまま保存する（schema は `Json?`）。実データ調査（2026-09-15）で `aisignage/lfuser` の
 * `managementInfo` が `{}`（空オブジェクト）になっているケースを確認した。`{}` は truthy のため
 * 旧コードの `managementInfo && managementInfo.commands.length > 0` は通過してしまい、直後の
 * `managementInfo.commands.length` で `TypeError` を投げていた。`apps/web` には Error Boundary が
 * 無かったため、この 1 箇所の例外だけで画面全体（ヘッダー・ナビ含む）が白くなっていた。
 */

/** 1 本の管理コマンド（`label`/`command` が両方とも文字列のものだけを有効とみなす） */
export interface NormalizedManagementCommand {
  label: string;
  command: string;
}

/** 表示用に正規化された管理コマンド情報。`commands` は必ず配列（空配列を含む） */
export interface NormalizedManagementInfo {
  os: string;
  installType: string;
  commands: NormalizedManagementCommand[];
}

/**
 * `Machine.managementInfo`（型は `unknown` 相当。DB 上は無検証な `Json?`）を安全な形に正規化する。
 * - オブジェクトでない、または `commands` が配列でない場合は `null`
 *   （呼び出し側は既存の「Agent が接続すると管理コマンドが表示されます」フォールバックへ流れる。
 *   fail-closed: 情報が壊れているときは「管理コマンド欄を出さない」を選ぶ。誤った操作コマンドを
 *   表示するより安全なため）。
 * - `commands` の要素は `label`/`command` が両方とも string のものだけを残す（不正な要素は捨てる）。
 * - `os`/`installType` は欠損時 `''` にフォールバックする（表示側は `os === 'win32'`/`'darwin'` の
 *   分岐に乗るだけなので、空文字は自然に「Linux」表示へ落ちる）。
 */
export function normalizeManagementInfo(raw: unknown): NormalizedManagementInfo | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.commands)) return null;

  const commands: NormalizedManagementCommand[] = obj.commands.filter(
    (c): c is NormalizedManagementCommand =>
      c !== null &&
      typeof c === 'object' &&
      typeof (c as Record<string, unknown>).label === 'string' &&
      typeof (c as Record<string, unknown>).command === 'string',
  );

  return {
    os: typeof obj.os === 'string' ? obj.os : '',
    installType: typeof obj.installType === 'string' ? obj.installType : '',
    commands,
  };
}

/**
 * 日時文字列を `toLocaleString()` した結果、または不正な値のとき `fallback` を返す。
 * `new Date(invalid).toLocaleString()` はブラウザによって `'Invalid Date'` を返したり例外を投げたり
 * するため、呼び出し側で毎回 try/catch や null チェックを書かずに済むよう 1 箇所に集約する。
 */
export function formatDateTimeSafe(value: string | null | undefined, fallback = '-'): string {
  if (!value) return fallback;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return fallback;
  try {
    return d.toLocaleString();
  } catch {
    return fallback;
  }
}
