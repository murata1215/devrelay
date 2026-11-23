# 組織プロバイダー強制サイクル（2026-11-24）

## 背景

組織 admin が「返事の要約」のプロバイダーを Anthropic に変更したのを機に、「組織の統制でみんな同じ挙動にしたい。AI モデルの強制のような制御はできるか」という要望が出た。

既存の組織 AI デフォルト（#372）は AI モデル 8 キー（`<tool>_model_<plan|exec>`）のみが対象で、AI プロバイダー設定 7 キー（`*_provider`）は組織で統一できなかった。本サイクルで既存の仕組みをプロバイダー 7 キーにも拡張した。

## 対象 7 キー
`build_summary_provider` / `chat_ai_provider` / `dev_report_provider` / `terminal_ai_provider` / `voice_assist_provider` / `org_summary_provider` / `reply_summary_provider`

## 人間の決定事項（事前に確認・承認済み）

### 決定1（1-B を採用）: 組織既定を誰に適用するか
`decideEffectiveModel()` の判定表をモデルと完全に共通のまま使う。**canOverride=true（管理者・個別許可者）でも、個人設定が無ければ組織既定を採用する**。

これはプロバイダー設定が「どのモデルを使うか」ではなく**機能自体の ON/OFF スイッチ**（未設定＝無効）であることを踏まえた上での選択。組織既定を入れた瞬間、未設定だった人の機能が各自のキーで動き出す（課金が始まる）が、「みんな同じ挙動」を完全に実現するためこれを受容する。使いたくない人は個人設定で明示的に `none` を選べば上書きできる。

### 決定2（2-B を採用）: 強制したプロバイダーのキーを本人が持っていない場合
既存の `getApiKeyForProvider()` の環境変数フォールバック（`OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/`GEMINI_API_KEY`）は変更しない。本機の `.env` には `OPENAI_API_KEY` のみ存在するため:
- 組織が `openai` を強制 → 個人キーが無い人はサーバー共通キーで動く（運営者負担）
- 組織が `anthropic`/`gemini` を強制 → 個人キーが無い人はその機能が止まる

機能停止が無言にならないよう、組織既定（`source === 'org'`）が効いていて鍵が取れないときだけ `console.warn` を1行出す（鍵の材料は出さない）。Discord/Telegram には画面が無いため、`pm2 logs` が唯一の追跡手段。

## 実装

### サーバー: `services/org-ai-defaults.ts`（中心、外部 import ゼロの純粋関数を維持）
- `PROVIDER_KEY_PATTERN` / `isOrgAiProviderKey()` を追加、`isOrgAiDefaultKey()` をモデル8キー OR プロバイダー7キーに拡張
- `isValidOrgAiDefaultValue(key, trimmedValue)` 新設: プロバイダーキーは `openai|anthropic|gemini|none` の enum のみ許可、モデルキーは既存の危険文字・空白チェック（`@devrelay/shared` の `isUnsafeModelId` と同一正規表現だが import せず独自定義、循環依存回避の既存方針を維持）
- `isOrgProviderControlEnabled(raw)` 新設: `DEVRELAY_ORG_PROVIDER_DEFAULTS` キルスイッチ（既定有効、`'0'` で無効）。`process.env` 読みは呼び出し側（`update-busy-rules.ts` 等と同じ流儀）
- `isModelSettingLocked` → `isAiSettingLocked` にリネーム。第3引数（キルスイッチ env の raw 値）を追加し、プロバイダーキーのときだけキルスイッチで無効化できる（モデルキーは影響なし）

### サーバー: `services/user-settings.ts`
- `resolveProviderSetting(userId, key)` 新設（`resolveModelForTool` と同じ形。キルスイッチ OFF なら個人設定の生値のみ返す）
- プロバイダー取得 7 関数（`getApiKeyForBuildSummary`/`OrgSummary`/`ReplySummary`/`DevReport`/`ChatAi`/`TerminalAi`/`VoiceAssist`）の `getUserSetting` 直読みを `resolveProviderSetting` 経由に差し替え。各関数の既存セマンティクス（`'none'` 扱い・null 限定フォールバック・フォールバック順序）はすべて保持
- `source === 'org'` で鍵が取れないときに `warnOrgProviderKeyMissing()` で警告ログ

### サーバー: `routes/organization.ts`
- GET `/api/org/ai-defaults` に `providerControlEnabled: boolean` を追加
- PUT `/api/org/ai-defaults`: 値検証をキー種別で分岐。**キルスイッチ OFF 時はプロバイダーキーを 400 にせず、既存値をそのまま保持して黙ってスキップ**する（WebUI の組織デフォルト編集はマップ全体を再送するため、400 にすると管理者のモデル既定編集自体が壊れる）
- 変更内容を `console.log` で記録（DB 変更なしの縛りのため監査ログテーブルは使わない）

### サーバー: `routes/api.ts`
- PUT `/api/settings/:key` にプロバイダー値の enum 検証を追加（既存バグ修正: 不正な値が保存でき機能が黙って止まっていた）
- PUT/DELETE のロック判定を `isAiSettingLocked(userId, key, process.env.DEVRELAY_ORG_PROVIDER_DEFAULTS)` に変更

### サーバー: `services/command-handler.ts`
- `handleModelList`（`l` コマンド）に組織既定のプロバイダー一覧を表示する行を追加（Discord/Telegram には画面が無く、`l` が唯一の確認手段のため）
- ロック警告文言をプロバイダーも含む表現に修正

### WebUI: `SettingsPage.tsx`
- AI Provider Settings セクションを2カラム化（個人設定 + 組織デフォルト）。既存のモデル側ロック判定 `isModelKeyLocked`/`effectiveModelValue` はキー文字列ベースのためそのまま再利用し、プロバイダー専用の `isProviderKeyLocked`（キルスイッチも見る）・`effectiveProviderValue`（`PROVIDER_OPTIONS` に無い空文字を避けて `'none'` にフォールバック）を追加
- 管理者向け組織デフォルト編集 UI・一般メンバー向け読み取り専用表示の両方にプロバイダー7件を追加
- `providerControlEnabled === false` のときはロック表示・バナーを一切出さない

### WebUI: `lib/api.ts`
- `org.getAiDefaults()`/`updateAiDefaults()` の戻り型に `providerControlEnabled: boolean` を追加

## DB 変更
**なし。** `Organization.aiModelDefaults`（JSON文字列）と `OrganizationMember.canOverrideAiSettings` を流用。

## 対象外の経路（devlog に明記）
- embedding・ナレッジ検索（`getOpenAiApiKey` 直読み、`DEVRELAY_EMBEDDING_API_KEY`）
- `DEVRELAY_ANSWER_API_KEY` 系（ナレッジ回答・スレッド自動命名・ポータル要約）

これらは別のキー解決経路を使っており、本サイクルのプロバイダー強制の対象ではない。

## どの userId の組織ポリシーが効くか（機能ごとに異なる）
- `reply-summary.ts` は `session.userId`（応答を受け取るセッションの持ち主）
- `conversation-summarizer.ts` は `viewerUserId`
- `build-summarizer.ts` は呼び出し元の userId

クロスユーザー ask/teamexec では、相手側（プロジェクト所有者）の組織既定が効く場面がある点に注意。

## 既知の軽微な差分
- `getApiKeyForChatAi`/`TerminalAi`/`VoiceAssist` で、DB に空文字 `''` が入っている場合、旧実装はレガシーフォールバックが効いていたが、`resolveProviderSetting` の `|| undefined` 正規化後は組織既定が採用される。実害は無い想定。

## テスト
- `tests/org-ai-defaults.test.mjs`: プロバイダー関連のケースを追加（`isOrgAiProviderKey`・`isValidOrgAiDefaultValue`・`isOrgProviderControlEnabled`・`parseOrgAiDefaults`/`serializeOrgAiDefaults` のプロバイダー対応）
- 新規 `tests/org-provider-defaults-wiring.test.mjs`: ソース文字列検査で (a) プロバイダー7関数が `getUserSetting` 直読みから `resolveProviderSetting` 経由に変わったこと (b) PUT/DELETE が `isAiSettingLocked` を使うこと (c) キルスイッチ OFF 時に PUT が 400 を返さないこと (d) `l` コマンドがプロバイダー組織既定を表示すること を検証
- `pnpm build` 全6パッケージ green、サーバーテスト 2249件・WebUIテスト 1121件 全green

## Windows/実機未確認
WebUI の実際の表示崩れ（2カラムレイアウト・ロックバッジ・disabled 表示）は未確認。管理者権限での組織デフォルト保存・一般メンバーでのロック表示・個人設定 403 拒否・`l` コマンドの表示・キルスイッチ ON/OFF 切り替えの実機確認が必要。
