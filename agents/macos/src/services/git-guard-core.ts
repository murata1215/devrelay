/**
 * #368 Phase 2a: Devin プランモードの根治（パーミッションでの制御をやめ、git 自動復元ガードで
 * 安全性を担保する方式への転換）のための純粋関数群。
 *
 * #363〜#368 で確定した真因: Devin の `Exec()` パーミッションはトークン単位のプレフィックス一致で
 * あり、複合シェルコマンド（`&&`/`;`/パイプ）を個々の裸コマンド名に分解して判定するため、
 * allow-list 方式は構造的にモグラ叩きになる。並列ツール呼び出しのうち1つでも拒否されると
 * ターン全体が "Interrupting stop token" でキャンセルされ、exit 0・出力ゼロの無言終了になる
 * （#368 Phase 1 で確定）。
 *
 * このモジュールは Devin をパーミッションで縛る代わりに「ターン前の git 状態を記録し、
 * ターン後に自動で元へ戻す」ためのガードのコア判定ロジックを提供する（I/O は `git-guard.ts` 側）。
 *
 * `devin-file-watch.ts`/`devin-atif.ts`/`session-scope.ts`/`plan-permission.ts` と同じ流儀
 * （外部 import ゼロ、3 OS byte-for-byte 同一、`node:test` から `dist/` を直接 import してテスト）。
 */

/**
 * `git status --porcelain=v1 -z` の1レコード。
 * リネーム・コピー（`x === 'R' | 'C'`）のときのみ `origPath` が非 null になる。
 */
export interface PorcelainEntry {
  /** インデックス側のステータス文字（例: 'M','A','D','R','C','?' 等） */
  x: string;
  /** ワークツリー側のステータス文字 */
  y: string;
  /** 現在（新しい）パス */
  path: string;
  /** リネーム・コピー時の元パス。それ以外は null */
  origPath: string | null;
}

export type RestoreAction = 'checkout' | 'quarantine' | 'skip';

/**
 * 復元対象から除外するディレクトリ（DevRelay 自身の作業領域・成果物出力先・.git 内部）。
 * `.devrelay-output/` はユーザー向け成果物の出力先のため、誤って巻き戻すと成果物が消える。
 */
const GUARD_EXCLUDED_PATTERN = /(^|\/)(\.git|\.devrelay|\.devrelay-output)(\/|$)/;

/**
 * `git status --porcelain=v1 -z --untracked-files=all` の生出力（NUL 区切り）をパースする。
 * **実際の git 出力で実測して仕様を確定済み**: リネーム/コピー（インデックス側が `R`/`C`）は
 * `XY <space><newPath>\0<origPath>\0` という2トークン構成（新パスが先、元パスが後）。
 * 通常レコードは `XY <space><path>\0` の1トークン。
 *
 * 例外を投げない（不正な行は無視して次に進む）。
 * @param raw `git status --porcelain=v1 -z` の標準出力全体
 */
export function parsePorcelainZ(raw: string): PorcelainEntry[] {
  if (!raw) return [];
  const tokens = raw.split('\0');
  const entries: PorcelainEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    i++;
    if (tok === '') continue; // 末尾 NUL 等の空トークンは無視
    if (tok.length < 3) continue; // "XY " に満たない不正行は無視（防御的）
    const x = tok[0];
    const y = tok[1];
    const path = tok.slice(3);
    let origPath: string | null = null;
    if (x === 'R' || x === 'C') {
      const next = tokens[i];
      if (next !== undefined && next !== '') {
        origPath = next;
        i++;
      }
    }
    entries.push({ x, y, path, origPath });
  }
  return entries;
}

/**
 * 復元対象から除外すべきパスかどうかを判定する（`.git`/`.devrelay`/`.devrelay-output` 配下）。
 * `\` 区切りの Windows パスも `/` に正規化してから判定する。例外を投げない。
 */
export function isGuardExcludedPath(relPath: string): boolean {
  if (!relPath) return false;
  const f = relPath.replace(/\\/g, '/');
  return GUARD_EXCLUDED_PATTERN.test(f);
}

/**
 * パストラバーサル・絶対パス・NUL バイトを含む危険な相対パスを拒否する構造ガード。
 * `git-guard.ts` が実際にファイルシステム操作（rename 等）を行う前の最終防衛線。
 */
export function isSafeRelativePath(relPath: string): boolean {
  if (!relPath) return false;
  if (relPath.includes('\0')) return false;
  const normalized = relPath.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return false;
  if (/^[a-zA-Z]:\//.test(normalized)) return false; // Windows 絶対パス（例: C:/...）
  if (/^[a-zA-Z]:$/.test(normalized)) return false;
  const segments = normalized.split('/');
  if (segments.some((seg) => seg === '..')) return false;
  return true;
}

/**
 * ターン開始時（`before`）とターン終了時（`after`）の porcelain エントリを比較し、
 * 「このターン中に新たに変化したパス」だけを抽出する。
 *
 * 設計判断: ターン開始前から既に dirty だったパス（ユーザー自身の未コミット作業）は、
 * ステータスコードが変化しない限り対象に含めない（Devin が引き起こした変化のみを復元する）。
 * これにより「元々ユーザーが作業中だったファイル」を誤って巻き戻す事故を防ぐ
 * （ただし既存の dirty ファイルをこのターン中にさらに Devin が編集した場合、ステータスコード自体は
 * 変わらないため検知できない既知の限界がある＝保守的に「触らない」側に倒した設計）。
 *
 * @returns `after` のうち `before` と同じ `path` かつ同じステータスコードでないエントリの配列
 */
export function diffAgainstBaseline(before: PorcelainEntry[], after: PorcelainEntry[]): PorcelainEntry[] {
  const beforeStatus = new Map<string, string>();
  for (const e of before) {
    beforeStatus.set(e.path, `${e.x}${e.y}`);
  }
  const changed: PorcelainEntry[] = [];
  for (const e of after) {
    const key = `${e.x}${e.y}`;
    if (beforeStatus.get(e.path) !== key) {
      changed.push(e);
    }
  }
  return changed;
}

/**
 * 1エントリに対して行うべき復元アクションを判定する。
 * - 未追跡（`??`）: `quarantine`（削除ではなく `.devrelay/reverted/<ISO8601>/` へ退避）
 * - 無視対象（`!!`）: `skip`（.gitignore 対象、触らない）
 * - それ以外（追跡済みの変更・追加・削除・リネーム等）: `checkout`（git で HEAD の状態へ戻す）
 */
export function classifyRestoreAction(entry: PorcelainEntry): RestoreAction {
  if (entry.x === '?' && entry.y === '?') return 'quarantine';
  if (entry.x === '!' && entry.y === '!') return 'skip';
  return 'checkout';
}
