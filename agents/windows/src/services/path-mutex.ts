/**
 * プロセス内パスロック（#348 層 B: Agent 側の直交化 第 2 の防御）。
 *
 * 一時セッション（`session-scope.ts` の `isEphemeralSession()`）は projectPath 上の状態を
 * そもそも読み書きしない設計にするため、本来ロックは不要になる。しかし対話セッション同士
 * （例: `a` での切り替え直後の重複起動、Agent 再起動直後の二重初期化）が同一 projectPath の
 * `.devrelay/conversation.json` を同時に read-modify-write する可能性は残るため、
 * その保険として Promise チェーンによる直列化ロックを提供する。
 *
 * 外部 import ゼロの純関数のみで構成する（#332 `permission-policy.ts` 等と同じ流儀）。
 * `agents/linux` と `agents/macos` で byte-for-byte 同一内容を維持すること。
 */

/** キーごとの直列化キュー（末尾に積まれた Promise。解決済みなら次の呼び出しはすぐ実行できる） */
const lockChains = new Map<string, Promise<unknown>>();

/**
 * ロックキーを比較可能な形に正規化する（末尾スラッシュ除去・バックスラッシュ統一）。
 * `cross-query-guard.ts` の `normalizeProjectPath()` と同種の正規化だが、
 * こちらは大文字小文字を変えない（ファイルシステムパスをそのままキーに使うだけで、
 * 別マシンとの比較には使わないため過剰な正規化は不要）。
 *
 * @param path 正規化対象のパス
 */
export function normalizeLockKey(path: string): string {
  let p = path.trim();
  p = p.replace(/\\/g, '/');
  while (p.length > 1 && p.endsWith('/')) {
    p = p.slice(0, -1);
  }
  return p;
}

/**
 * 指定キーについて `fn` を直列実行する。同一キーへの呼び出しは前の呼び出しが完了する
 * （成功・失敗を問わず）まで待たされる。異なるキー同士は並行実行される。
 *
 * `fn` が throw / reject しても、次の待機者へは必ず制御が渡る（ロックは永久に塞がれない）。
 * 呼び出し元には `fn` の例外がそのまま伝播する。
 *
 * @param key ロック対象のキー（`normalizeLockKey()` 済みであることを推奨、内部では正規化しない）
 * @param fn 排他実行したい非同期処理
 */
export function withPathLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = lockChains.get(key) ?? Promise.resolve();

  // 前段の成否に関わらず自分の番が来たら実行する（catch で握りつぶして次に繋ぐ）
  const runAfterPrevious = previous.then(
    () => fn(),
    () => fn(),
  );

  // チェーンに自分を積む。後続の待機者用に「成否を問わず完了した」ことだけを伝える薄いラッパーを保持する
  const chainEntry = runAfterPrevious.then(
    () => undefined,
    () => undefined,
  );
  lockChains.set(key, chainEntry);

  // マップの肥大化を防ぐため、自分が最後の待機者であれば掃除する
  chainEntry.finally(() => {
    if (lockChains.get(key) === chainEntry) {
      lockChains.delete(key);
    }
  });

  return runAfterPrevious;
}

/**
 * 現在アクティブな（未解決の）ロックチェーンの件数を返す（テスト用）。
 */
export function getActiveLockCount(): number {
  return lockChains.size;
}
