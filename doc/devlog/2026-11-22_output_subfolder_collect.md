# .devrelay-output サブフォルダ成果物が無言で消える既存バグの根治（2026-11-22）

## 要求
AI がターン専用フォルダ（`.devrelay-output/turn_<id>/`）配下にサブフォルダを作って成果物を
整理すると、`collectTurnOutputFiles()` が直下しか見ていないため無言で送信されず消えていた。
また 1 ファイル 5MB の上限超過も console.log のみでユーザーに一切伝わらなかった。

## 実行
- `agents/{linux,macos,windows}/src/services/output-collector.ts`: 再帰収集 `walkTurnFiles()` を
  新設（symlink は辿らない）。戻り値を `FileAttachment[]` から `CollectedOutput{attachments,skipped}`
  に変更し、呼び出し元（`connection.ts` 2 箇所 × 3 機種）を配線し直した。上限を 1 ファイル 5MB→25MB、
  合計 40MB、件数 50、深さ 5 に設定し、上限超過・読み取り失敗は `SkippedOutput` として記録、
  `buildSkippedOutputNotice()` で AI 応答本文の末尾に注意文として追記するようにした。
  MIME マップに webp/mp4/webm/mov/mp3/wav/m4a/ogg/docx/xlsx/pptx を追加。
- サーバー側: filename が `/` 区切りの相対パスを持つようになったことに対応。
  `attachment-validation.ts` に `sanitizeOutputRelPath()`（`..` 脱出を閉じる）を新設し
  `agent-manager.ts` の `handleAiOutput()` で適用。`packages/shared/src/text.ts` に
  `outputFileBaseName()` を新設し、`api.ts`（ZIP エントリ名）・`dev-report-generator.ts`
  （HTML img src）・`discord.ts`/`telegram.ts`（添付名）で basename 化に使用。
  Discord/Telegram は送信前にサイズ上限チェックを追加し、超過時は添付せず本文に注意を
  1 行追記するようにした（以前は例外で本文テキストまで送られなくなっていた）。
  `apps/server/src/index.ts` の WS `maxPayload` を 100MiB に明示指定。

## 検証
- shared: 177/177 pass。server: 2112/2112 pass（新規 `attachment-validation.test.mjs` +47 行分含む）。
- agents: linux 1457/1457（`--test-concurrency=1`、2 skip）・macos 918/918（同、3 skip）・
  windows 220/220 pass。新規・拡張ケースとして再帰収集・symlink 不追従・too-large/total-limit
  スキップ・`buildSkippedOutputNotice()` の文面を各機種の `output-turn.test.mjs` に追加。
- 6 workspace `pnpm build` green。

## 発見
- 3 機種の `output-collector.ts` は本サイクル分の差分が byte 同一（既存の指示文ブロックのみ
  linux/macos と windows で相違、従来どおり）。
- linux/macos のテスト実行で `file-handler.test.mjs`・`session-store-scope.test.mjs` が
  Node 内部テストランナーの IPC デシリアライズエラー（`Unable to deserialize cloned data`）で
  落ちたが、本サイクルの変更対象ファイルではなく `--test-concurrency=1` では再現しなかった
  （既知の無関係な flaky）。
