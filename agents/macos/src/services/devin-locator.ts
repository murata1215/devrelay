/**
 * サイクル P3-A: `resolveSystemDevin()` が使う OS 別のコマンド文字列・フォールバック候補パスを
 * 純関数として切り出したもの（`claude-locator.ts` の鏡写し）。
 *
 * `devin-path.ts` からのみ利用される。外部 import ゼロに保ち、コンパイル済み dist を直接
 * `node --test` から import して単体検証できるようにする。
 */

/**
 * devin の所在を PATH から引くコマンド文字列を返す。
 * @param platform `process.platform` の値（'win32' | 'darwin' | 'linux' 等）
 * @returns Windows は `where devin`、それ以外は `command -v devin`
 */
export function buildDevinLookupCommand(platform: string): string {
  return platform === 'win32' ? 'where devin' : 'command -v devin';
}

/**
 * PATH で見つからなかったときに順に試す絶対パス候補（OS 別）。
 * 存在しない端末では従来どおり全て空振りし `resolveSystemDevin()` は null を返す（誤検知を増やさない）。
 * @param platform `process.platform` の値
 * @param home ホームディレクトリ（`os.homedir()` の値）
 * @returns 候補パスの配列（存在確認は呼び出し側が行う）
 */
export function devinFallbackCandidates(platform: string, home: string): string[] {
  if (platform === 'win32') {
    return [
      `${home}\\AppData\\Roaming\\npm\\devin.cmd`,
      `${home}\\AppData\\Local\\Programs\\devin\\devin.exe`,
      `${home}\\.local\\bin\\devin.cmd`,
    ];
  }
  return [
    `${home}/.local/bin/devin`,
    '/usr/local/bin/devin',
    '/usr/bin/devin',
  ];
}
