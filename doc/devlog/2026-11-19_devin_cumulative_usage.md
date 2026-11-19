# 2026-11-19 Devin コストの累計記録による過大計上を修正

## 症状
Usage 画面で 土橋（300Z0346 / PC45/exuser59）の 11 月が $1,090.89。Devin の請求画面は $83.06。

## 原因
- 土橋の Devin ターンは 47/47 で全トークン項目が前ターン以上（累計の形。同じ cache_read が連続する等）。他の機体は増減がランダム（ターン分）。
- Agent は ATIF（`devin --export`）の `final_metrics` をそのまま今回ターンの usage にしていた（`ai-runner.ts` close ハンドラ）。
  resume すると ATIF は過去ターンを含む全トラジェクトリを書き直す（#365）ため、その環境では `final_metrics` がセッション累計になる。
- 各スレッド最終ターンの値の合計 = $13.65 + $66.62 + $1.28 + $0.84 = $82.39 ≒ 実請求。Agent のバージョンは全員同じ（11/17）。

## 修正
- `agents/{windows,linux,macos}/src/services/devin-atif.ts`（3 OS 同一）
  - `extractAtifStepMetrics()` / `AtifDigest.stepMetrics`: ステップごとの `metrics`（prompt/completion/cached）
  - `resolveAtifTurnUsage()`: resume かつ `0 < stepOffset < totalSteps` のときだけ補正。
    ステップ metrics の全合計が final_metrics と一致すれば offset 以降の合計（`steps`）、
    そうでなく前ターン累計以下が無ければ差分（`delta`）、それ以外はそのまま（`total`）
- `session-store.ts`: 前ターン終了時の累計を `devin-atif-usage-offset.json` に保存（`saveDevinAtifStepOffset` の第 4 引数）。
  `clearDevinAtifStepOffset` で一緒に消す（`x`・モデル変更・resume 失敗時）
- `ai-runner.ts`: `usageData.usageMode` と `cumulativeUsage`（補正時のみ）を記録。補正時は `[devin] usage mode=...` をログ
- `packages/shared/src/types.ts` `AiUsageData`: `usageMode` / `cumulativeUsage` を追加
- 既存データ: `apps/server/src/services/devin-cumulative-fix-rules.ts` + `scripts/devin-cumulative-fix.ts`
  （`pnpm --filter @devrelay/server devin:cumulative-fix [-- --from YYYY-MM-DD --machine <名前> --apply]`）

## 適用・検証
- PC45/exuser59 に `--apply`: 140 行、全期間 $3,322.50 → $224.65、11 月 $82.39。再実行で書き換え 0 行（冪等）
- テスト: agents devin-atif 83/83（linux/macos）、server devin-cumulative-fix-rules 6/6
- 他の小さい候補（YOSHINAO YAMAMOTO 6/6・katohiro・SK岩田 等、単調 100%）は件数が少なく判別できないため未適用

## miyazawa（DESKTOP-NVH9KQJ/miyazawa）の差 → 原因はフルシート
- 請求期間（11/4〜）で DevRelay $156.97、請求画面 $55.83。
- Devin のメンバーシップで miyazawa だけシート種類が「フル」（他は Flex）。請求画面の金額は定額を超えた
  オンデマンド分だけなので、差 $101.14 はフルシートの定額でまかなわれた分。DevRelay の値は使用量として正しく、補正しない。
- Usage 画面の見出し下に「フルシート利用者は定額分も含めた使用量の金額（請求画面のオンデマンドコストとは一致しない）」の注記を追加。
