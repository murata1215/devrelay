/**
 * スレッド一覧の「(無題)」大量発生の根治 サイクルB: `Session.title` が無いスレッドの
 * 表示ラベルを `Message.content` から導出するための前処理（コマンドタグ除去 / AI 応答
 * ノイズ除去）を行う純関数群。外部 import ゼロ（`thread-list-filter.ts` / `thread-scope.ts`
 * と同じ流儀。node:test から `dist/` を直接 import して検証する）。
 *
 * 【最重要・不変条件】この用途のためだけに `Session.title` へ自動生成値を書き込むことは
 * しない（書くと `PATCH /api/sessions/:id` によるユーザー明示リネームと区別がつかなくなり
 * 後戻りできない）。ここで導出した値は `GET /api/threads` のレスポンスへ都度計算して
 * 載せるだけで、DB へは永続化しない。
 */

/**
 * ユーザーメッセージ先頭に付くコマンドタグのパターン（`command-handler.ts` が
 * `Message.content` に書き込む形式: `[exec] <指示>` / `[w] ...` / `[teamexec] ...`）。
 */
const COMMAND_TAG_PATTERN = /^\[(exec|w|teamexec)\]\s*/;

/**
 * ユーザーメッセージ先頭のコマンドタグ（`[exec] `/`[w] `/`[teamexec] ` 等）を取り除く。
 * タグを除去した結果、本文が残らない場合（タグ単体、またはタグ+空白のみ）は
 * ラベルの材料にならないことを示す `null` を返す。`raw` が `null`/非文字列/空白のみの
 * 場合も `null` を返す（呼び出し側の分岐を単純にするための fail-soft 設計）。
 */
export function stripCommandTag(raw: string | null): string | null {
  if (typeof raw !== 'string') return null;
  const stripped = raw.replace(COMMAND_TAG_PATTERN, '').trim();
  return stripped === '' ? null : stripped;
}

/**
 * 進捗マーカー行のパターン（ja / en 両対応）。
 * `services/progress-markers.ts` の `PROGRESS_LINE_PATTERNS` の複製。
 * 本モジュールは「外部 import ゼロ」規約（`thread-list-filter.ts` 等と同じ）を維持するため
 * サーバー内の他モジュールからも import せず定数を複製する。挙動の一致は
 * `tests/thread-label-source.test.mjs` の突き合わせテスト（ソースガード）で保証する。
 */
const PROGRESS_LINE_PATTERNS: readonly RegExp[] = [
  /^🔧\s*.+を使用中\.\.\.$/u,
  /^🔧\s*Using\s+.+\.\.\.$/u,
];

/**
 * contextInfo 行（📊 Rate Limit 等 / 📝 系）の先頭一致パターン。
 * `agent-manager.ts` の `extractBuildSummary()` 内 `text.replace(/^[📊📝].+\n?/gm, '')` と
 * 論理的に同一（1 行ずつ判定する形に書き換えた複製）。挙動の一致は上記と同じテストで保証する。
 */
const CONTEXT_INFO_LINE_PATTERN = /^[📊📝].+$/;

/**
 * AI 応答メッセージ（`role: 'ai'`。`'assistant'` ではない）の `content` から、
 * ラベルの材料にならないノイズ行を取り除く。
 * `content = contextPrefix + mark + output`（`agent-manager.ts:673-674`）という構造上、
 * 剥がさないと `📊 Rate Limit ...` のような行がそのままタイトル候補になってしまう。
 * 除去後、行が1つも残らなければ `null` を返す。
 */
export function stripAiNoise(raw: string | null): string | null {
  if (typeof raw !== 'string') return null;
  const kept: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (CONTEXT_INFO_LINE_PATTERN.test(trimmed)) continue;
    if (PROGRESS_LINE_PATTERNS.some((re) => re.test(trimmed))) continue;
    kept.push(trimmed);
  }
  return kept.length === 0 ? null : kept.join('\n');
}
