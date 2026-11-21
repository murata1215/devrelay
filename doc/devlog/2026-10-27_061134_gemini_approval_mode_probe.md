# Gemini CLI の plan ターンが probe 結果を無視し `--approval-mode` 非対応機で会話不能になる問題の根治 (2026-10-27)

## 経緯

`x220-158-18-103/gemini-user` 機体で「こんにちは」と送っただけで以下のエラーになった（Discord/WebUI 経由、plan ターン）。

```
❌ gemini CLI が出力なしで終了しました（exit 1）。
[stderr]
  -v, --version   Show version number
  -h, --help      Show help
Unknown arguments: approval-mode, approvalMode
```

サーバーログ（`pm2 logs devrelay-server`）から機体を特定し、`agent.log` 側は Agent の home が
`devrelay` ユーザーから読めない別 OS ユーザー所有のため、ソースコードとエラー文言から根治した。

## 調査

2026-10-26（`2026-10-26_233258_gemini_exec_shell.md`）で gemini 分岐に `usePlanMode` 分岐を追加した際、
`probeGeminiCapabilities()` は `--approval-mode`（auto_edit/yolo choice 付き）/`--yolo` の対応可否を
判定しているにもかかわらず、**else 節（plan ターン、または yolo 系フラグに非対応の場合）が probe 結果を
一切見ずに `--approval-mode auto_edit` をハードコードしていた**：

```ts
if (wantYolo && geminiCaps.approvalModeYolo) { args = ['--approval-mode', 'yolo']; }
else if (wantYolo && geminiCaps.yoloFlag)    { args = ['--yolo']; }
else { args = ['--approval-mode', 'auto_edit']; }   // ← ここ。probe 結果を見ていない
```

`gemini-user` の Gemini CLI は `--approval-mode` フラグ自体を持たない旧版のため、yargs の `strict()` が
`Unknown arguments: approval-mode, approvalMode` で exit 1・stdout 空となり、`ai.cliFailed` に落ちていた。

重要: これは 2026-10-26 サイクル（exec の yolo 化）の退行ではない。plan ターンの argv は
2026-10-26 の前後で一切変わっていないため、**この機体の Gemini は DevRelay 導入以来一度も
会話が成立していなかった**（旧コードの該当箇所は `doc/devlog/2026-09-12_110544.md:102` に
既知の穴として記録済み）。母艦（`devrelay` ユーザー、Gemini 0.65.0）では `--approval-mode` が
`default/auto_edit/yolo/plan` choices を全て持つため今回の事故は再現しない。

## 対応

判定結果を無視する構造的な穴を塞ぐため、承認モード argv の決定ロジックを `packages/shared` の
純粋関数に切り出し、3 エージェントの個別ハードコードを廃止した（`capability-rules.ts` /
`service-path-rules.ts` と同じ「純粋 rules モジュール + `node --test`」方針）。

- `packages/shared/src/gemini-args.ts`（新規）
  - `parseGeminiCapabilities(help)`: `gemini --help` から `model`/`approvalMode`/`approvalModeAutoEdit`/
    `approvalModeYolo`/`yoloFlag` を判定。`--approval-mode` の choices 判定は、ヘルプ全体への緩い正規表現
    （`-y, --yolo` 行にも誤マッチしうる）ではなく、`--approval-mode` の出現位置から次のオプション行までの
    スパンに限定して判定するよう厳密化した。
  - `buildGeminiApprovalArgs(caps, { usePlanMode, yoloEnabled, droppedFlags })`: plan/exec とキャパから
    argv と劣化理由（`GeminiDegradeReason`）を決定。**`--approval-mode` 非対応時は plan ターンでも
    フラグ無しで起動する**（今回の事故ケースの根治）。
- `agents/{linux,macos,windows}/src/services/ai-runner.ts`
  - `probeGeminiCapabilities()` の判定本体を `parseGeminiCapabilities()` に委譲（cache 構造は維持）。
    probe 失敗時も「それでも auto_edit を渡す」という従来の楽観フォールバックを廃止し、
    全フラグ false（`GEMINI_CAPABILITIES_NONE`）にした上で `buildGeminiApprovalArgs()` に委ねる
    （未検証フラグを渡して全滅するより、CLI 既定で起動する方が安全側）。
  - capabilities ログに `gemini --version` を追加（「どの版か」が切り分けの第一手になるよう）。
  - gemini 分岐の if/else チェーンを `buildGeminiApprovalArgs()` 呼び出しに置き換え、劣化理由ごとに
    1 回だけ警告（#325 静かなフォールバック禁止）。
- `packages/shared/src/i18n.ts`
  - `gemini.approvalModeUnsupported`（`--approval-mode` 自体に非対応）/ `gemini.probeFailed`
    （`gemini --help` 実行自体の失敗）を追加。既存 `gemini.yoloUnsupported` はそのまま。

### Phase 2: 実行時の自動リトライ安全網

probe が誤判定しても、ユーザーがヘルプ全文のエラーを見ないようにする最後の砦として、Devin の
`--permission-mode` 非対応検出（#329 `devinUnknownFlagMatch`）と同じ仕組みを gemini に移植した。

- `SendPromptOptions.geminiDroppedFlags?: string[]`（`devinDroppedFlags` と同じ形）を追加。
- プロセス終了ハンドラで、stdout 空かつ stderr が `Unknown arguments?: ...` にマッチし、その内容から
  `--approval-mode` / `--yolo` のいずれかに特定できた場合、そのフラグを 1 つ落として
  `sendPromptToAi()` を再帰呼び出し（最大 2 回、devin と同一ガード）。
- `buildGeminiApprovalArgs()` の `droppedFlags` に渡し、落ちたフラグを候補から除外する
  （純粋関数なのでテストで検証済み）。
- i18n: `gemini.unknownFlagRetry` / `gemini.unknownFlagFailed`（devin の対応キーと同じ文面構造）。

### キルスイッチ

既存 `DEVRELAY_GEMINI_YOLO=0`（exec も plan と同じ経路に落とす）はそのまま。
新しいキルスイッチは追加していない — 今回の変更は「非対応フラグを渡さない」だけで、対応 CLI
（母艦の 0.65.0 を含む全ての `--approval-mode` 対応 CLI）では argv が従来と 1 バイトも変わらない。

### 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `packages/shared/src/gemini-args.ts` | 新規。`parseGeminiCapabilities` / `buildGeminiApprovalArgs` |
| `packages/shared/src/index.ts` | 上記の named export 追加 |
| `packages/shared/src/i18n.ts` | `gemini.approvalModeUnsupported` / `gemini.probeFailed` / `gemini.unknownFlagRetry` / `gemini.unknownFlagFailed` 追加 |
| `packages/shared/tests/gemini-args.test.mjs` | 新規。実ヘルプ fixture 3 種（現行版/旧版/最旧版）で決定表・droppedFlags を網羅（14 テスト） |
| `agents/linux/src/services/ai-runner.ts` | probe 委譲 + gemini 分岐差し替え + Phase 2 リトライ |
| `agents/macos/src/services/ai-runner.ts` | 同一変更（既存コードが linux と同一だったため） |
| `agents/windows/src/services/ai-runner.ts` | 同一変更（`log.info`/`log.warn`/`log.error` を使う点のみ差異） |

## 今回やらないこと

- plan ターンの機構的 readonly 化（`--approval-mode plan`）。2026-10-26 サイクルと同じ理由でスコープ外。
- `gemini-user` 機体の Gemini CLI 自体の更新。コード修正だけでも plan ターンは通るようになるが、
  旧 CLI のままでは exec の `run_shell_command` 自動承認（`--yolo`）はあっても他の非互換が残る
  可能性があるため、CLI 更新自体はユーザー作業（Agent の home が `devrelay` から読めないため）。

## 検証

- `pnpm --filter @devrelay/shared build && node --test packages/shared/tests/gemini-args.test.mjs`:
  14 テスト green（現行版/旧版/最旧版の決定表 + droppedFlags）。
- 母艦の実際の `gemini --help`（0.65.0）を `parseGeminiCapabilities()` に通し、plan/exec の argv が
  2026-10-26 サイクル後の挙動と完全に同一（`--approval-mode auto_edit` / `--approval-mode yolo`）であることを
  手動確認（＝この母艦では無回帰）。
- `agents/{linux,macos,windows}` を個別に `npx tsc --noEmit` で green 確認。
- `pnpm build`（モノレポ全体）green。
- `pnpm -r test`: `packages/shared` 118/118、`apps/server` 1380/1380、`apps/web` 924/924、
  `agents/linux` 1164/1164、`agents/macos` 727件中726 pass + skip1、`agents/windows` 149/149、
  いずれも green（1 回目の実行で `handle-conversation-clear.test.mjs` / `conversation-store-scope.test.mjs` /
  `file-handler.test.mjs` が毎回別のファイルで `ERR_TEST_FAILURE`（Node test runner の IPC デシリアライズ
  失敗）になったが、単体再実行・直後の再実行で都度 green になり、本変更と無関係な既知の test runner
  flake と確認済み）。

## 反映

`agents/*` 変更のため、Gemini を使用する全機体で commit + push 後に `u`（自己更新）が必要。
`packages/shared` の dist はビルドされるが `apps/server`・`apps/web` のランタイムコードは無変更のため
`pm2 restart devrelay-server` は不要。DB マイグレーションなし。

`gemini-user` 機体は `u` 後、plan ターンの会話自体は通るようになる（`--approval-mode` 非対応のため
フラグ無し起動＋`gemini.approvalModeUnsupported` 警告 1 行）。exec でシェル実行を自動承認したい場合は
別途 Gemini CLI 自体の更新が必要（本サイクルでは未実施、人間側実施待ち）。
