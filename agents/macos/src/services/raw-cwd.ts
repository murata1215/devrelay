/**
 * raw-completion（ゲーム席用の素の completion API）の cwd を中立な固定ディレクトリへ解決する
 * （Phase 1.4）。純ロジック（`resolveRawCwdPath` / `isRawCwdStatAcceptable`）と実 I/O
 * （`ensureRawCwd`）を分離し、純ロジックのみを `node --test` から直接テストできるようにする
 * （`raw-completion-mode.ts` と同じ流儀）。
 *
 * 背景（プラン §変更2）: raw 経路の cwd がこれまで対象プロジェクト（DevRelay 管理下の git
 * リポジトリ）のパスそのものだったため、SDK が自動注入する `type:"environment"` アタッチメント
 * （cwd・OS・シェル・日付・モデル名）にプロジェクトパス・ユーザー名・プロジェクト名がそのまま
 * 載っていた（2.1.278 実測）。cwd を中立ディレクトリへ差し替えることでこの経路を塞ぐ。
 *
 * cwd の選定（`/tmp/seat`、POSIX 固定）:
 *   - `$XDG_RUNTIME_DIR/seat`: 不採用。crontab `@reboot` nohup 起動では systemd ユーザーセッションが
 *     無く `XDG_RUNTIME_DIR` が未設定（実機 uso8m で確認済み）。設定されていてもパスに UID が入る。
 *   - `os.tmpdir()/seat`: 不採用。`TMPDIR` 環境変数次第でユーザー名入りパスに化けうる。
 *   - `~/.devrelay/raw-cwd`: 不採用。devrelay・ユーザー名の両方を含む（人間指示の禁止条件に抵触）。
 *   - `/tmp/seat`: 採用。パスに devrelay・ユーザー名・ホスト名を一切含まず、全 POSIX 機に存在する。
 *
 * 安全策: `/tmp` は共有ディレクトリのため、既存の `/tmp/seat` が他ユーザー所有・symlink・
 * ディレクトリでない等の場合に備え、作成後に `lstat` で検証する。不合格ならプロセス寿命中 1 回だけ
 * `mkdtemp` にフォールバックする（呼び出しごとの増殖を避けるため、結果はモジュール内にキャッシュする）。
 *
 * `agents/macos` は本ファイルと byte-identical。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** `/tmp/seat` 固定パス（POSIX、Phase 1.4 で採用した中立 cwd。プラン §変更2-a 参照） */
export const RAW_CWD_PRIMARY_PATH = '/tmp/seat';

/**
 * `fs.lstatSync()` の結果から純ロジックが必要とする最小限の形（外部型 import を避けるための
 * duck-typing インターフェース）。
 */
export interface RawCwdStatLike {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  uid: number;
}

/**
 * `RAW_CWD_PRIMARY_PATH` に存在するエントリが raw-completion の cwd として使ってよいかを判定する
 * （純関数）。合格条件: ディレクトリである・symlink でない・所有 uid が自プロセスの uid と一致する。
 * いずれか一つでも満たさなければ `false`（呼び出し元は `mkdtemp` フォールバックへ回る）。
 *
 * @param stat 対象パスの `fs.lstatSync()` 相当
 * @param processUid 実行中プロセスの uid（`process.getuid()` 相当。Windows 等 uid 概念が無い環境では
 *                    呼び出し元が本関数自体を使わない想定のため、ここでは常に数値を要求する）
 */
export function isRawCwdStatAcceptable(stat: RawCwdStatLike, processUid: number): boolean {
  if (!stat.isDirectory()) return false;
  if (stat.isSymbolicLink()) return false;
  if (stat.uid !== processUid) return false;
  return true;
}

/**
 * raw-completion の cwd として使う絶対パスを決定する（純関数、実際の mkdir/lstat は行わない）。
 * `platform` が `'win32'` の場合のみ `os.tmpdir()` 配下（`%TEMP%\seat`）にフォールバックする
 * （Windows Electron agent は raw-completion 対象外＝D4 だが、型上の完全性のために用意する。
 * `os.tmpdir()` の Windows での既知の制約＝ユーザー名を含むパスになりうる点は許容する、
 * プラン §変更2-a 参照）。
 *
 * @param platform `process.platform` 相当
 * @param tmpdir `os.tmpdir()` の戻り値（Windows フォールバック用。POSIX では未使用）
 */
export function resolveRawCwdPath(platform: string, tmpdir: string): string {
  if (platform === 'win32') {
    // `path.join`（`path.win32.join` ではない）はランタイム OS 依存でセパレータを選ぶため、
    // このモジュールが POSIX ホスト上でテストされる際も Windows 形（`\`）を期待するテストが
    // 通るよう、常に `path.win32` を明示的に使う。
    return path.win32.join(tmpdir, 'seat');
  }
  return RAW_CWD_PRIMARY_PATH;
}

/**
 * プロセス寿命中 1 回だけ生成される `mkdtemp` フォールバック先のキャッシュ（`ensureRawCwd()` が
 * 複数回呼ばれても増殖しないようにするため）。
 */
let cachedFallbackPath: string | null = null;
/** 解決済みの cwd のキャッシュ（本命 `/tmp/seat` が使えた場合もここに記録し、毎回 I/O しない） */
let cachedResolvedPath: string | null = null;

/**
 * raw-completion 用の中立 cwd を実際に用意する（I/O 実体）。`RAW_CWD_PRIMARY_PATH`
 * （POSIX）または Windows フォールバックパスを `mkdir -p`（mode 0700）した上で `lstat` により
 * 安全性を検証し、不合格なら `fs.mkdtempSync()` にフォールバックする。
 *
 * 結果はプロセス内でキャッシュする（呼び出しごとに mkdir/lstat をやり直さない。`mkdtemp`
 * フォールバックが選ばれた場合も同じ一時ディレクトリを使い回すことで、スラッグ増殖を
 * プロセスあたり最大 1 に抑える）。
 *
 * @returns 実際に使う cwd の絶対パス
 */
export function ensureRawCwd(): string {
  if (cachedResolvedPath) return cachedResolvedPath;

  const primary = resolveRawCwdPath(process.platform, os.tmpdir());
  try {
    fs.mkdirSync(primary, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(primary);
    const processUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
    if (isRawCwdStatAcceptable(stat, processUid)) {
      cachedResolvedPath = primary;
      return cachedResolvedPath;
    }
    console.warn(`⚠️ [raw-cwd] ${primary} failed safety check (not a plain dir owned by this process) → falling back to mkdtemp`);
  } catch (err) {
    console.warn(`⚠️ [raw-cwd] failed to prepare ${primary}: ${(err as Error).message} → falling back to mkdtemp`);
  }

  if (!cachedFallbackPath) {
    cachedFallbackPath = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-'));
  }
  cachedResolvedPath = cachedFallbackPath;
  return cachedResolvedPath;
}
