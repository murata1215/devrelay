# Pulse（会話履歴レール）タブ増殖バグの根治（2026-11-22）

## 要求
Pulse から別スレッドを開くたびに新しいタブが増え続け、プロジェクトタブバーが
横スクロール前提のまま埋まって到達できないタブが生まれていた。VS Code 方式の
プレビュータブ（閲覧専用の仮タブ）と、増えたタブの一括クローズ手段が無かった。

## 実行
- 新規 `apps/web/src/lib/tab-preview-rules.ts`・`tab-close-rules.ts`（純関数、テスト付き）。
  `Tab.preview` フラグを追加し、Pulse からの選択は `openPreviewTab()` でプレビュータブとして
  開く（既存の同じ会話のプレビュータブは差し替え）。入力・送信・ピン止め・リネーム・D&D・
  サイドバーからの明示選択のいずれかで `promoteTabById()` が通常タブへ昇格させる。
  tab_order への保存は `persistTabOrder()`（`collectPersistedTabIds()` でプレビュータブを除外）
  に一本化した。
- `TabBar` を `overflow-x-auto`（横スクロール 1 行）から `flex-wrap`（多段折り返し、
  `max-h-[30vh] overflow-y-auto` の安全弁付き）に変更。右クリックメニュー（このタブ/他の
  タブ/以降のタブ/すべて閉じる、ピン止めは常に除外）を `position: fixed` で追加。
- 同じコミットに、別サイクル（.devrelay-output サブフォルダ収集）由来の `ChatPage.tsx` 内
  表示変更（`download` 属性の `outputFileBaseName()` 化、動画・音声のインライン再生カード）
  が同居している。ファイルを分けてコミットできないため本コミットに含めた。
- 新規ソースガード `tab-preview-source-guards.test.mjs`（saveTabOrder 呼び出しの一本化・
  Pulse 選択経路・右クリックメニュー方式・既存 D&D 退行3点の非再導入を確認）。

## 検証
- web: 1116/1116 pass（新規 `tab-preview-rules.test.mjs` 159 行・`tab-close-rules.test.mjs`
  142 行・`tab-preview-source-guards.test.mjs` 70 行を含む）。
- `apps/web/dist` ビルド green（vite build 含む）。

## 発見
- `knowledge-source-guards.test.mjs` の ChatPage.tsx 行数ピンが前回コミット（96a1f47 相当の
  4654）のまま更新されておらず、実測（`split('\n').length` で 4675）とずれて赤くなっていた。
  本サイクルのコミット前に実測値へ更新（4654 → 4675）。
