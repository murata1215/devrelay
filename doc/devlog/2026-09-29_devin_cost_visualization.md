# 2026-09-29 ｜ Devin 料金可視化 Phase2-3（ATIF 実キー修正 + 単価構造化 + Conversations コスト列）

## 背景

ユーザーから「devinって料金の可視化ってできそう？」という質問。調査プランサイクルで Devin の
課金データ取得可否を調査した結果を提示し、実装承認を得て本サイクルを実施した。

## 調査で判明した事実

### Devin の実額（ACU）は Enterprise 契約限定

Devin 公式 API の ACU 取得系（`GET /v3/enterprise/consumption/daily`、
`/consumption/daily/users/{user_id}`、ACU cost 付きの `/v3/enterprise/sessions`）は
すべて `/v3/enterprise/` 配下で、Enterprise 契約 + service user token +
`ViewAccountConsumption` 権限が必要。ユーザーの契約は **Team プラン**のため対象外と判断
（Phase4 として拡張余地のみ残す）。

self-serve/Team プランは ACU 表記が廃止され「included quota + 超過分は API pricing」に
移行済みのため、**トークン数 × 公開単価**が実課金の良い近似になる。

### Devin のトークン数がほぼ全ゼロだった根本原因

実 DB 調査で `aiTool='devin'` の ai メッセージ 579 件中 usageData 付きが 110 件のみ、
しかも大半のモデルでトークン数が完全にゼロだった。`agents/{linux,macos,windows}/src/
services/devin-atif.ts` の `extractAtifUsage()` が想定していたキー名
（`total_input_tokens`/`total_output_tokens`/`total_cache_read_tokens`/
`total_cache_creation_tokens`）が実機に存在せず、欠落フィールドを 0 埋めする実装のため
常に全ゼロを返していたと特定。

`devrelay-ask-member` skill で Devin 接続機（`tisa-lenovo/lfuser` のプロジェクト `Lafit`）へ
**読み取り専用**の調査を依頼し、`%TEMP%` に残っていた失敗ターンの ATIF エクスポートファイル
（2026-09-05 付、モデル `kimi-k2-7`、DevRelay は失敗ターンのエクスポートファイルを削除せず
温存する仕様を利用）から実キー名を確認した:

```json
{
  "total_prompt_tokens": 40820,
  "total_completion_tokens": 1097,
  "total_cached_tokens": 24885,
  "total_steps": 11
}
```

`total_prompt_tokens`/`total_completion_tokens`/`total_cached_tokens` が正しいキー名で、
`total_cache_creation_tokens` に対応するフィールドは存在しない（Devin はキャッシュを
read/write に分けて報告しない）。モデル `kimi-k2-7` は DB 実測で全ゼロだった実測モデルと
一致しており、原因を確定できた。

### `Session.aiTool` はツール帰属の判定に使えない

`apps/server/src/services/command-handler.ts` の `l` コマンドが既存 `Session` を
`aiTool` で上書きするため、`aiTool='devin'` のセッションに過去の Claude ターンの行が
混入する（実 DB で確認: 混在セッションあり）。集計・コスト推定でこの列を信用すると
実は Claude だった行を Devin 単価で誤って計算する恐れがある。

### `AiUsageData.modelUsage` のコメント誤り

`packages/shared/src/types.ts` の旧コメントは「モデル別**セッション累積**トークン」と
していたが、実 DB を1セッション内で14ターン追跡した結果、`costUSD`・各トークン数は
単調増加せず変動しており、`outputTokens`/`cacheReadInputTokens` は同メッセージの
`usage.output_tokens`/`usage.cache_read_input_tokens` と完全一致することを確認した。
**ターン単位**（メッセージ1件分）の値であり、メッセージ横断で単純合算してよい。

副産物として、Claude 側は `modelUsage[model].costUSD` にAgent SDK が返す**実額**が
既に保存されていることも判明した（`aiTool='claude'` の 9,959 件中 9,728 件に存在、
累計 $59,625.64 相当、9月単月で $45,037.42）。WebUI には一切表示されていなかった。

## Phase2: Agent 側バグ修正（`agents/{linux,macos,windows}`）

- `devin-atif.ts` の `extractAtifUsage()`: 実測キー（`total_prompt_tokens` 等）を
  優先し、旧キー（`total_input_tokens` 等）はフォールバックとして残す。
  **既知キーが1つも見つからなければ 0 埋めせず `null` を返す**よう変更
  （「$0.00 に見える嘘のコスト行」を作り続けるバグの根治）。
- `ai-runner.ts`: `durationMs` 欠落バグを修正。既存の `devinStartTime`
  （heartbeat 用、`if (aiTool === 'devin') {...}` ブロックスコープ）は close ハンドラから
  参照できないため、関数スコープに `devinTurnStartedAt` を追加。`digest.usage` が
  `null` でも `{ durationMs, tool: 'devin' }` は必ず記録するよう変更
  （旧実装は usage が無いと usageData 自体を作らず、Conversations 一覧の
  Duration が常に「-」だった）。
- `packages/shared/src/types.ts`: `AiUsageData` に `tool?: AiTool` を追加
  （`Session.aiTool` が信用できない問題への対策。optional なので旧 Agent との
  後方互換は維持）。`modelUsage` の誤ったコメントを「ターン単位」に訂正。

## Phase3: 単価構造化とコスト表示

- 新規 `packages/shared/src/model-pricing.ts`（純関数のみ、Node API 非依存）:
  - `DEVIN_MODEL_PRICING`: `AI_MODEL_CATALOG.devin` の description に埋め込まれた
    `$a/$b/$c per MTok` 表記を機械可読な構造体として複製。**`AI_MODEL_CATALOG` 自体の
    構造・件数・順序は変更しない**（`model-catalog.test.mjs` の deepEqual を壊さない）。
    二重管理は新規テストで description との数値一致を検査して防止。
  - `normalizeDevinModelId()`: DB 実測 15 種のモデル ID
    （`swe-1-7-medium`/`claude-sonnet-5-medium`/`claude-opus-4-6[1m]`/`kimi-k2-7`/
    `gpt-5-6-luna-medium` 等）を正規化。`[1m]` 長文脈サフィックス・`-fast`
    （単価が別、非 fast 単価への流用は禁止）・推論量サフィックス
    （`-low/-medium/-high/-xhigh/-max/-lightning`）・ハイフン区切りバージョン番号の
    ドット復元を処理。
  - `resolveDevinModelPrice()`: カタログに無いモデル（`kimi-k2-7`/`swe-1-7-*`/
    `MODEL_PRIVATE_11` 等）への単価 fallback は一切行わない（常に `undefined`）。
  - `estimateCostUsd()`: cache-write（キャッシュ書き込み）単価は Devin の公開表に
    列が無いため、Claude の実データ校正（`costUSD=1.5069985` の残差から
    入力単価 × 1.25 ≒ $6.25/MTok と逆算確認）を初期値として採用。
  - `resolveMessageCost()`: 優先順位 ① `modelUsage[model].costUSD`（Claude SDK 実額、
    `source:'sdk'`） ② `usageData.tool==='devin'` かつ単価判明（`source:'estimate'`、
    **`Session.aiTool` は信用せず `usageData.tool` の明示のみで判定**） ③ それ以外は
    `source:'unknown'`・`usd:null`（**`0` にしない**）。`CostSource` に将来の
    Enterprise API 連携用に `'enterprise'` を予約。
- `apps/server/src/routes/api.ts`: `/api/conversations` に `costUsd`/`costSource` を
  追加（既存フィールドは不変）。
- `apps/web/src/pages/ConversationsPage.tsx`: PC 表・モバイルカード・展開パネルの
  3箇所に Cost 表示を追加。`source:'estimate'` のみ `~$0.42` とチルダを付け、
  `unknown` は `-`（`$0.00` は表示しない）。`apps/web/src/i18n/messages.ts` に
  `conversations.cost.*` を en/ja 対で追加。

副次効果として、`resolveMessageCost()` は Claude 行にも機能するため、Conversations の
Cost 列は Claude の実額（累計 $59,625.64 相当）も同時に可視化されるようになった。
専用の `/cost` ダッシュボードや日別バーチャート、サブスク向け「実請求と一致しない」
バナー等はユーザーの指示（「Devinだけでいいよ」）により本サイクルのスコープ外とした。

## スコープ外

- Phase1（Claude 専用の `/cost` ダッシュボード等）: ユーザー指示により見送り。
- Phase4（Devin Enterprise API 連携、実 ACU 取得）: 契約が Team プランのため対象外。
  `CostSource` に `'enterprise'` を予約済みで、将来追加しやすい形にしてある。

## テスト

- 新規 `packages/shared/tests/model-pricing.test.mjs`（17件）: description⇔構造体の
  数値一致・DB 実測 15 キーの正規化・優先順位3パターン・`Session.aiTool` 誤帰属の
  回帰テストを含む。
- `agents/{linux,macos}/tests/devin-atif.test.mjs` に3件追加（実測キーマッピング・
  実測キー優先・未知スキーマ→null）。Windows agent には元々 `devin-atif.test.mjs`
  が存在しない（既存のギャップ、今回は対象外）。

## 検証

- `pnpm build`: 6 workspace すべて green
- `node --test`: shared 70/70・server 762/762・web 518/518・linux 1038/1038・
  macos 601/602+1skip すべて green（linux 実行中に無関係な `file-handler.test.mjs` の
  並列テスト起因 flake を1回 observed、単独実行では 19/19 green、既存の並列実行時
  flake と確認）
- `grep -c 'require(' apps/web/dist/assets/index-*.js`: 0（#309/#310 白画面事故の
  再発防止チェック）

## 反映

`packages/shared`（`types.ts`/`index.ts`/新規 `model-pricing.ts`）+ `apps/server`
（`api.ts`）+ `apps/web`（`api.ts`/`ConversationsPage.tsx`/`messages.ts`）+
`agents/{linux,macos,windows}`（`devin-atif.ts`/`ai-runner.ts`）+
`agents/{linux,macos}`（テスト）を変更。

**`pm2 restart devrelay-server` 必須**（server/web/shared 変更のため）。
**Devin 接続機のみ各機 `u` 必須**（Agent 側コード変更のため。少なくとも
`tisa-lenovo/lfuser` の `Lafit` プロジェクトを含む）。DB マイグレーション不要
（`Message.usageData` は既存の Json 型のまま）。

commit/push は本サイクルで実施。
