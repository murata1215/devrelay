# クロスユーザー Team: 「公開中のプロジェクト」にチーム名を表示 + 停止確認文言の正確化

## きっかけ

直前までの一連のサイクル（招待の複数選択・再招待の行き止まり修正・招待候補フィルタ修正）を
実機でフル往復テストした結果、すべて設計どおり動作することを DB で確認した:

| 確認項目 | 結果 |
|---|---|
| 再招待（行き止まり修正） | `invite_sent` 4 件。409 で弾かれず pending に戻っている |
| 招待候補フィルタ修正 | 公開済みの yahoo が候補に出て再招待できた |
| 複数選択の承認 | `pixblog-flutter` と `mimamori-flutter` が 3ms 差（`06:55:40.065`/`.068`）で作成＝単一トランザクションのループが動作 |
| 監査ログ 1 プロジェクト 1 行 | `invite_accepted` 5 件（単一承認 3 + 複数承認 2） |

その過程で、ユーザーのスクリーンショットから UI 表示の問題を 2 件発見した。

## 発見した問題

### ① 「公開中のプロジェクト」が重複登録に見える
yahoo の「公開中のプロジェクト」に `mimamori-flutter` が 2 行並んでいた。実際は
`AskTestTeam` と `pixterm` の 2 チームへ同一プロジェクトを公開している正しい状態だが、
`GET /api/teams/shared-by-me` が返す `teamName` を `TeamPage.tsx` の描画が使っておらず、
どのチーム経由の公開かが分からなかった。

`ask` の宛先解決への影響を確認: `listCrossTeamAskCandidateProjects()`
（`apps/server/src/services/cross-team-authz.ts`）は `grantByProjectId`
（`projectId` をキーにした `Map`）で重複を畳むため、同一プロジェクトが複数チームに
公開されていても候補は 1 件に収束する。SQL で「公開チーム数 2 / dedup 後の候補 1」を
確認済み。gmail 側の自分のプロジェクトにも完全一致するものが無いため、
`ask mimamori-flutter:` は一意に解決し、同名衝突は起きない。

### ② 「公開を停止」の確認文言が不正確
旧文言「このプロジェクトへの質問受け付けを停止しますか？相手は以後このプロジェクトに
ask できなくなります。」は、同一プロジェクトが複数チームに公開されているケースでは誤り。
1 つの `CrossTeamGrant` を revoke しても、他チーム経由の grant が生きていれば
引き続き ask できる。

## 実装内容

`apps/web/src/pages/TeamPage.tsx` のみ変更:

- 「公開中のプロジェクト」の各行に `— チーム「{teamName}」の {requesterName} さんが
  質問できます` の形でチーム名を追加
- `handleStopSharing` の引数を `teamMemberId: string` から `share: CrossTeamShare`
  に変更し、確認ダイアログの文言を以下に変更:
  - 対象チーム名とプロジェクト名を明示
  - `sharedByMe` を `projectId` で絞り込み、同じプロジェクトが他チームにも
    公開されている場合だけ「（同じプロジェクトを他のチームにも公開しているため、
    そちらは残ります）」の注記を追加

純関数への切り出しは行わなかった（描画と `window.confirm` の文言生成のみで、
分岐も「他チームに同じ `projectId` があるか」の 1 つだけのため）。

## 検証

`pnpm build` 全 6 workspace green。web バンドルに CJS `require(` 混入なしを確認。
`apps/web` の `node --test` 931/931（既存のみ・非退行）。

## 変更ファイル

既存 `apps/web/src/pages/TeamPage.tsx` のみ。**サーバー側の変更なし**
（`teamName`/`projectId` とも前サイクルで既にレスポンスに含まれていた）。
新規ファイルなし。DB スキーマ変更なし・新規キルスイッチなし。
ソースコード変更ありのため `pnpm build` 実行済み、再起動が必要。

## 未解決（別サイクルで対応予定）

- 公開型本体（`Team.visibility` + `TeamSubscription`、`decideCrossTeamAccess()` は無改造）
- 同名衝突の解決手段（`ask <project>@<machine>:` 形式や候補への採番）。現状は実害が
  出ていないが、公開型で他人のプロジェクトが大量に候補へ入ると必須級になる
- プロジェクトのリネーム UI が Team ページにしか無い問題
