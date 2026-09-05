// #364 1-C 真因B: Windows では `bash` が WSL または Git bash のどちらかに解決され、
// 実行環境ごとに必要なパス名前空間（/mnt/c/... または /c/...）が異なる。
// この2つの変換を純関数として切り出す（外部importゼロ、byte-for-byte同一を linux/macos で維持）。
//
// 実測（.devrelay-files/20260906_005320_pasted-text.txt 他、#364 1-C プラン参照）:
//   - WSL bash:     /mnt/c/Users/... のみ有効（tilde・C:\...・/c/... は全て失敗）
//   - Git bash:     /c/Users/... のみ有効（tilde・/mnt/c/... は全て失敗）

/**
 * Windows 形の絶対パス（`C:\...` または `C:/...`）からドライブレターと残りの部分を取り出す。
 * ドライブレター形式に一致しない入力（UNCパス・既に POSIX 形の入力等）は null を返す。
 * 例外は投げない。
 */
function extractDriveAndRest(winPath: string): { letter: string; rest: string } | null {
  if (typeof winPath !== 'string' || winPath.length === 0) return null;
  const normalized = winPath.replace(/\\/g, '/');
  const match = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (!match) return null;
  return { letter: match[1].toLowerCase(), rest: match[2] };
}

/**
 * `C:\Users\x\.claude\skills` → `/mnt/c/Users/x/.claude/skills` （WSL）。
 * ドライブレター形以外の入力は null。
 */
export function toWslPath(winPath: string): string | null {
  const drive = extractDriveAndRest(winPath);
  if (!drive) return null;
  return `/mnt/${drive.letter}/${drive.rest}`;
}

/**
 * `C:\Users\x\.claude\skills` → `/c/Users/x/.claude/skills` （Git bash / MSYS2）。
 * ドライブレター形以外の入力は null。
 */
export function toGitBashPath(winPath: string): string | null {
  const drive = extractDriveAndRest(winPath);
  if (!drive) return null;
  return `/${drive.letter}/${drive.rest}`;
}
