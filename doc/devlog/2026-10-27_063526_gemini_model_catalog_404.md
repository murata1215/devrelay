# Gemini モデルカタログの死んだ ID 2 件の修正 + 廃止モデル 404 の診断メッセージ化 (2026-10-27)

## 経緯

前サイクル（commit `08ed948`、`--approval-mode` probe 無視の根治）の反映後、`gemini-user` 機体で
再テストしたところ、**狙いどおり警告 1 行つきで CLI が起動するところまで進んだ**上で次の壁に当たった:

```
⚠️ この端末の Gemini CLI は --approval-mode 自体に対応していないため、CLI 既定の承認モードで起動します。
❌ gemini CLI が出力なしで終了しました（exit 1）。
[stderr]
[API Error: {"error":{"message":"{\n  \"error\": {\n    \"code\": 404,\n    \"message\":
\"This model models/gemini-2.5-pro is no longer available to new users.
Please update your code to use models/gemini-3.1-pro-preview for the latest features
and improvements. ...\"
```

## 調査

サーバーログで `🧠 sendPromptToAgent model resolved: (default) (aiTool=gemini, explicit=none)` を確認 →
**DevRelay は `-m` を渡していない**。この 404 は `gemini-user` の旧 CLI が自前の既定モデル
`gemini-2.5-pro` を使い、それが Google 側で廃止されたために発生した。

母艦（gemini-cli 0.65.0）で DevRelay と同じ呼び出し（`-m` なし）を実機再現したところ正常応答。
`~/.gemini/settings.json`・`state.json` にモデル指定は無く、バンドル内の `DEFAULT_GEMINI_MODEL`
は 0.65.0 でも `"gemini-2.5-pro"` のままだが、新しい CLI はサーバー側ルーティング
（`auto-gemini-2.5`）で生きているモデルへ解決するため実害が出ない。
**⇒ `gemini-user` 側の 404 は CLI を更新すれば解消する（DevRelay 側の不具合ではない）。**

### その過程で見つけた本物の DevRelay バグ

カタログ検証のため `AI_MODEL_CATALOG.gemini`（`packages/shared/src/constants.ts`）の全 ID を
母艦の実 API で `gemini --skip-trust --approval-mode plan -m <id> -p "Reply with exactly: OK"`
により 1 件ずつ実測した結果、**6 件中 2 件が全ユーザー・全マシンで hard 404** と判明した:

| カタログ ID | 実測結果 | 備考 |
|---|---|---|
| `gemini-3.1-pro` | ❌ NOT_FOUND | 「最新フラッグシップ」として先頭に出る＝最も選ばれやすい。正しい ID は `gemini-3.1-pro-preview`（pro 系は `-preview` サフィックス必須） |
| `gemini-2.5-pro` | ❌ NOT_FOUND | Google が廃止済み。既存アカウントでも 404（CLI バージョン無関係） |
| `gemini-3.6-flash` / `gemini-3.5-flash` / `gemini-3.1-flash-lite` / `gemini-2.5-flash` | ✅ OK | |

カタログ外も実測し `gemini-3.1-pro-preview`・`gemini-3.8-flash`・`gemini-3.5-flash-lite` が有効と
確認（`gemini-3.8-pro`/`3.6-pro`/`3.5-pro`/`3.1-flash`/`2.5-flash-lite` は NOT_FOUND）。

`AI_MODEL_CATALOG.gemini` は WebUI の Settings ドロップダウン（`SettingsPage.tsx:1683,1758`）と
`l` コマンド（`command-handler.ts:1625,1670`）の**両方**を駆動しているため、「Gemini 3.1 Pro」
（旧カタログ先頭）を選んだユーザーは機種・CLI バージョンを問わず必ず失敗していた。
`isUnsafeModelId()` はシェル注入対策のみで存在検証はしないため、誰もこれを止められない構造だった。

これは `constants.ts` 冒頭の JSDoc が自ら警告している罠（「カタログに ID を追加するだけでは不十分、
実機で試してから追加すること」。同 JSDoc は「この規則は Claude 側で過去 2 度破られた」と明記）の
**3 度目**で、`gemini-3.1-pro` は #309 実装時に実機未検証のまま入った ID だった。

## 対応

### Phase 1: カタログ修正

`packages/shared/src/constants.ts` の `AI_MODEL_CATALOG.gemini` を実測結果で差し替え:
- `gemini-3.1-pro` → `gemini-3.1-pro-preview` に修正
- `gemini-2.5-pro` を削除（Google 側の永久廃止。codex カタログの「旧 CLI のために残置する」慣習は
  「新 CLI は知らないが旧 CLI では動く」ケース向けであり、サーバー側廃止には適用しない例外とした）
- `gemini-3.8-flash`（現行世代）・`gemini-3.5-flash-lite` を追加

JSDoc イラスト例（3 エージェントの `ai-runner.ts` コメント、`apps/server/src/services/user-settings.ts`）
の `gemini-3.1-pro` も `gemini-3.1-pro-preview` に更新（実行に影響しない例示コメントだが、死んだ ID を
放置しないため）。Devin 側カタログの `gemini-3.1-pro`（`AI_MODEL_CATALOG.devin`、Devin 自身の slug
名前空間）と `model-pricing.ts` の `DEVIN_MODEL_PRICING['gemini-3.1-pro']` は Devin 側の正しい ID
のため変更していない（Gemini ツールのカタログとは別軸）。

### Phase 2: 廃止モデル 404 の診断メッセージ化

今回ユーザーに届いたのは二重エスケープされた生 JSON で、次の一手が読み取れなかった。

`packages/shared/src/gemini-args.ts` に純粋関数 `detectGeminiModelUnavailable(stderr)` を追加:
- `models/<id> is no longer available`（今回の実機ログの形式）と
  `models/<id> is not found for API version`（`ModelNotFoundError`、対話モードで見られる別形式）
  の両方を検出し、モデル名を抽出
- Google のメッセージに `use models/<new>` が含まれていれば推奨移行先も抽出（今回の実例がまさにこの形）

3 エージェントの `ai-runner.ts` の gemini 終了ハンドラに、Phase 2（#329 由来の自動リトライ）の
直後の同じ位置に 1 分岐追加。stdout 空かつ検出成立で `gemini.modelUnavailable`（新規 i18n キー）を
出す。推奨移行先が無ければ `gemini-3.1-pro-preview`（新カタログの flagship）にフォールバックする。
文面は「① CLI 更新（新しい CLI は自動で有効なモデルに解決） ② `l <モデル>` で明示指定して今すぐ直す」
の 2 択を案内する。

## 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `packages/shared/src/constants.ts` | `AI_MODEL_CATALOG.gemini` 差し替え + 実測ログコメント |
| `packages/shared/src/gemini-args.ts` | `detectGeminiModelUnavailable()` 追加 |
| `packages/shared/src/i18n.ts` | `gemini.modelUnavailable` 追加 |
| `packages/shared/tests/gemini-args.test.mjs` | 実 stderr fixture 2 種のテスト追加（3件） |
| `agents/{linux,macos,windows}/src/services/ai-runner.ts` | 404 検出分岐を1つ追加、JSDoc 例示を修正 |
| `apps/server/src/services/user-settings.ts` | JSDoc 例示のみ修正（実行に影響なし） |

## 今回やらないこと

- `AI_MODEL_CATALOG.devin` の `gemini-3.1-pro`（Devin 側 slug、別名前空間）は変更しない
- モデル存在チェックを起動前に行う（`-m` 指定時の事前検証）仕組みの追加。今回は実測で既知の
  7 ID に絞るのみで、新モデル追加時の実機検証を自動化する話は別サイクル

## 検証

- `pnpm --filter @devrelay/shared build && node --test packages/shared/tests/gemini-args.test.mjs`:
  17 テスト green（前サイクルの14 + 今回追加3）
- 新カタログ全7 ID を母艦の実 API で再検証（`gemini --skip-trust --approval-mode plan -m <id> -p
  "Reply with exactly: OK"`）、**全件 OK** を確認
- 3 エージェントを個別 `npx tsc --noEmit` で green
- `pnpm build`（モノレポ全体）green
- `pnpm -r test` 相当の個別実行: shared 121/121・server 1380/1380・web 924/924・
  macos 727件中726pass+skip1・windows 149/149 green。linux は並列実行下で毎回別ファイルが
  `ERR_TEST_FAILURE`（既知の Node test runner IPC flake、前サイクルで確認済みと同種）になったが
  `--test-concurrency=1` で 1164/1164 green、本変更と無関係と再確認

## 反映

`packages/shared` の `AI_MODEL_CATALOG`/i18n を `apps/server`・`apps/web` が参照するため、
前サイクルと異なり**本サイクルは `pm2 restart devrelay-server` が必要**（WebUI の Settings
ドロップダウンの表示内容・`l` コマンドの許可カタログが変わるため）。`agents/*` の
`detectGeminiModelUnavailable()` 診断メッセージ化は Gemini 使用機の各機 `u` が必要。
DB マイグレーションなし。新しいキルスイッチは追加していない（死んだ ID の除去とエラー文面の
改善のみで、戻す意味のある挙動変更がない）。

`gemini-user` 機体自体の 404 解消には、別途 CLI 更新（`npm i -g @google/gemini-cli@latest` 等）が
必要（人間側実施待ち、本サイクルでは未実施）。更新せず今すぐ試す場合は `l gemini-3.1-pro-preview`
で回避可能（`UserSettings` 単位のためマシン単位ではない点に注意）。
