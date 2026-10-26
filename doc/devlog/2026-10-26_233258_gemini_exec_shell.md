# Gemini CLI の exec モードでシェル実行が機能しない問題の根治 (2026-10-26)

## 経緯

実機（`gemini` プロジェクト、`a 2` で Gemini CLI に切替）で「"こんにちは、けいすけさん" と話す音声ファイルを作って」と依頼し、`e`（exec）を送信したところ、Gemini は

> 現在の Gemini CLI 実行環境（Auto-Edit モード）ではシェル実行権限が付与されていないため、
> ワンクリックで MP3 を一括生成できるスクリプトを用意しました。
> ターミナルにて以下のコマンドを実行してください: `bash .../generate_speech.sh`

と応答し、`edge-tts` を実行せず `generate_speech.sh`/`.py`/`greeting_player.html` のみを `.devrelay-output/` に置いて終了した（MP3 は生成されなかった）。ユーザーから「gemini、e でも実行権限付与されなかったのかな？」と報告を受け調査した。

## 調査

Explore サブエージェントで Gemini/Claude/Codex/Devin の起動引数を横断比較した結果、`agents/{linux,macos,windows}/src/services/ai-runner.ts` の gemini 分岐が

```ts
const args = ['--approval-mode', 'auto_edit'];
```

を **`options.usePlanMode` を一切見ずに**固定していることを確認した。Gemini CLI 0.65.0 の `--help` によれば `auto_edit` は編集系ツールのみ自動承認し `run_shell_command` は確認プロンプトを要求する。DevRelay は Gemini をTTY無しの非対話（stdin にプロンプト投入）で起動するため、この確認に誰も答えられず、Gemini 自身が「権限がない」と判断して諦めていた。

これは既知の穴として記録済みだった:
- `doc/devlog/2026-09-12_110544.md:102`「gemini の `--approval-mode auto_edit` ハードコード（`usePlanMode` を見ていない）」
- `doc/devin_gate_investigation.md:82,239`「Gemini は plan/exec とも `auto_edit`（差分なし）」
- `rules/project.md:2360,2426`

他 AI との比較（`doc/devin_gate_investigation.md:79-82`）では、Codex だけが plan/exec で argv を変えている（`-c sandbox_mode="read-only"` vs `"danger-full-access"` + `approval_policy="never"`）。claude は SDK の `permissionMode`、devin は常に `dangerous`（plan 自体を使わない）。**Gemini だけ plan/exec の区別が機構的に存在しなかった。**

Gemini は毎ターン新規 spawn の使い捨て（resume 機構を持たず、会話履歴は毎回プロンプトに詰め直される）ため、argv を変えれば次ターンから即座に効く。設定ファイル（`~/.gemini/settings.json`）への書き出しは DevRelay 側に一切存在しないため、argv 分岐が唯一の打ち手。

## 対応

Codex の分岐パターンに倣い、`agents/{linux,macos,windows}/src/services/ai-runner.ts` の gemini 分岐を以下のように変更:

- `usePlanMode === false`（exec ターン）: `--approval-mode yolo`（Gemini CLI 側が choices に `yolo` を持たない旧バージョンは `--yolo` へフォールバック）
- `usePlanMode === true`（plan ターン）: 従来どおり `--approval-mode auto_edit`

`probeGeminiCapabilities()`（`gemini --help` のキャッシュ済みプローブ）を拡張し、`--model` に加えて `--approval-mode`（yolo choice を含むか）・`--yolo` の対応可否を判定する。probe 失敗時・両フラグ非対応時は従来どおり `auto_edit` へ悲観的に劣化させ、exec ターンでそうなった場合はプロセス寿命中 1 回だけ `onOutput()` で警告する（`packages/shared/src/i18n.ts` に `gemini.yoloUnsupported` を追加、#325 静かなフォールバック禁止方針に従う）。

キルスイッチ `DEVRELAY_GEMINI_YOLO`（Agent 実行環境の環境変数、既定 `1`）。`0` を設定すると exec でも常に `auto_edit`（= 完全に変更前の挙動）に戻る。

### 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `agents/linux/src/services/ai-runner.ts` | gemini 分岐の `usePlanMode` 対応分岐、`probeGeminiCapabilities()` 拡張、警告ラッチ追加 |
| `agents/macos/src/services/ai-runner.ts` | 同上（linux と同一コードの複製） |
| `agents/windows/src/services/ai-runner.ts` | 同上（`log.info`/`log.warn` を使う点のみ差異） |
| `packages/shared/src/i18n.ts` | `gemini.yoloUnsupported`（ja/en）追加 |
| `doc/changelog.md` | 本サイクルのエントリ追加 |
| `rules/project.md` | 「プラン相の書き込み不可強制」節に exec 側変更の注記を追加（gemini を `ENFORCED_READONLY_AI_TOOLS` に加える判断は変更していない） |
| `doc/devin_gate_investigation.md` | 比較表（Gemini 行）に 2026-10-26 追記 |

## 今回やらないこと

- plan ターンの機構的 readonly 化（`--approval-mode plan`）。`--approval-mode plan` は Gemini 自身のプランモード用システムプロンプトを注入し Agreement v6 のプラン出力書式に影響しうるため、別軸として今回はスコープ外。`ENFORCED_READONLY_AI_TOOLS = ['claude', 'codex']` に gemini を加える判断もしていない。
- Gemini の個別ツール承認（WebUI/Discord への承認カード）。Gemini CLI には Claude SDK の `canUseTool` に相当する外部承認フックが無いため、exec は codex/devin と同じ「全自動承認」。ユーザーの「以降すべて許可」設定（`skipPermissions`）は gemini では引き続き無視される。

## 検証

- `packages/shared`・`agents/linux`・`agents/macos`・`agents/windows` を `npx tsc --noEmit` で個別に型チェック、全て green（`packages/shared` を先にビルドしないと linux 側で `i18n.ts` の新キーが dist 型に反映されず TS2345 になる点に注意）。
- `pnpm build`（モノレポ全体）で最終確認。
- commit + push 後、Gemini を使用する実機で `u` を実行し、起動ログ（`🔧 Running: gemini --approval-mode yolo ...`）と `probeGeminiCapabilities` の capabilities ログを確認する必要がある（本サイクルでは未実施、人間側実施待ち）。
- 実機シナリオ（今回の再現ケース）: `a 2` → MP3 作成依頼 → プラン確認 → `e` → `.devrelay-output/greeting_female.mp3`/`greeting_male.mp3` が実際に生成されること。

## 反映

`agents/*` 変更のため、Gemini を使用する全機体で commit + push 後に `u`（自己更新）が必要。`apps/server`・`apps/web`・`packages/shared` の型定義以外のランタイムコード・DB は無変更のため `pm2 restart devrelay-server` は不要（`packages/shared` の dist はビルドされるが server 自体の挙動には影響しない）。DB マイグレーションなし。
