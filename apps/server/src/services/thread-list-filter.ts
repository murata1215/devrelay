/**
 * スレッド一覧の「(無題)」大量発生の根治 サイクルA: `GET /api/threads` の where に
 * 「ended かつ Message が1件も無い（コマンドのみ実行された抜け殻 / Agent オフラインで
 * 起動失敗した抜け殻）」スレッドを除外するフィルタを追加する純関数群。
 * 外部 import ゼロ（node:test から dist/ を直接 import する。thread-scope.ts と同じ流儀）。
 *
 * 【最重要】`buildEphemeralSessionIdExclusion()`（thread-scope.ts:52-56）は where の
 * トップレベル `NOT` キーを既に占有している。本モジュールが `NOT` キーで返すと
 * オブジェクトリテラルのスプレッドでキー衝突が起き、一時セッション除外が黙って消える
 * （型エラーにもテスト失敗にもならず本番でしか気付けない）。
 * そのため「NOT(ended AND empty)」をド・モルガンの法則で「active OR hasMessage」に
 * 書き換え、衝突しない `AND` キーで返す。
 */

/** `buildEmptyEndedThreadExclusion()` の戻り値型。Prisma の SessionWhereInput は import しない
 * （本モジュールの「外部 import ゼロ」規約を維持するため。構造的に代入可能な最小形のみ宣言）。 */
export interface EmptyEndedThreadExclusion {
  AND?: Array<{ OR: Array<{ status: string } | { messages: { some: Record<string, never> } }> }>;
}

/**
 * 「ended かつ Message が1件も無い」スレッドを一覧の where から除外するフィルタを返す。
 * `enabled=false` のときは `{}`（空オブジェクト）を返す。where にスプレッドしても
 * キーが1個も増えないため、キルスイッチ OFF は「従来の where とバイト等価」であることを
 * 機械的に主張できる（= 挙動変更ゼロであることの構造的な保証）。
 *
 * 生成される SQL の意味: `AND (status = 'active' OR EXISTS(... Message ...))`
 * — 「ended」かつ「Message 0 件」の行だけが除外される。「＋新規」直後の
 * active・Message 0 件のスレッドは `status='active'` 側で残る。
 */
export function buildEmptyEndedThreadExclusion(enabled: boolean): EmptyEndedThreadExclusion {
  if (!enabled) return {};
  return { AND: [{ OR: [{ status: 'active' }, { messages: { some: {} } }] }] };
}

/**
 * `DEVRELAY_THREADS_HIDE_EMPTY_ENDED` 環境変数を解釈する。
 * 既定 ON（'0' が明示されたときのみ無効）。`DEVRELAY_PLAN_STRICT_CHAT` と同じ流儀。
 */
export function isHideEmptyEndedEnabled(raw: string | undefined): boolean {
  return raw !== '0';
}
