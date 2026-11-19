# ヘルプ（h）を環境に合わせて出し分ける (2026-11-18)

## 背景
会社 devrelay は `DEVRELAY_TESTFLIGHT=0`・Discord/Telegram 未使用（WebUI のみ）なのに、`h` のヘルプに使えないテストフライト 8 行や、WebUI では意味のない `link`、未実装の `sum（準備中）` が出ていた。

## 変更
- `apps/server/src/services/command-parser.ts` `getHelpText(lang, opts?: { platform })`
  - 節ごとに組み立てて `\n\n` で連結（条件外の節は除外）
  - テストフライト節: `isTestflightEnabled(process.env.DEVRELAY_TESTFLIGHT)` が false なら非表示
  - スレッド引継ぎ節: `isThreadHandoverEnabled(process.env.DEVRELAY_THREAD_HANDOVER)` が false なら非表示（パーサの判定と同じ）
  - `link`: platform が `web` なら非表示（handleLink は web だと「不要」を返すだけ）
  - `login` 節: platform が `web` 以外なら非表示（web 専用）。platform 未指定時は全節表示
  - `sum` の行を削除（コマンド自体は残す）
- `apps/server/src/services/command-handler.ts`: `getHelpText(lang, { platform: context.platform })`
- `apps/server/tests/help-text.test.mjs`: 出し分けの 4 テストを追加、既存の testflight cp テストは env を明示的に未設定にして実行

## 検証
- `pnpm build` 成功、`node --test tests/help-text.test.mjs` 8/8 green
- `DEVRELAY_TESTFLIGHT=0` + platform web で出力を目視確認（テストフライト・link・sum 無し、login あり）

## 反映
サーバー再起動のみ（Agent の `u` 不要）。
