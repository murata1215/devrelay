# クロスユーザー Team Phase 1 実機テストと 2 件のバグ修正

## きっかけ

2026-11-05 に実装したクロスユーザー Team（Phase 0 + Phase 1、ask のみ）を一度も実機で
動かしていなかった。ユーザーが個人アカウントで小さな組織を作り（gmail + yahoo の 2 アカウント、
同一組織）、招待 → 承認 → ask の往復を実際にテストした。

## テストの経過

1. `DEVRELAY_CROSS_TEAM=1` を `.env` に追加 → `pm2 restart` → **効いていなかった**（後述バグ2）
2. symlink で解決 → 再起動 → `+ Invite` ボタンが出現
3. gmail が yahoo を `AskTestTeam` に招待 → yahoo が `mimamori-flutter` を選んで承認
4. `CrossTeamGrant` を SQL 確認: `askAllowed=true` / `execAllowed=false` / `revokedAt=null`
   （「2 キー方式」の実証）
5. gmail のチャットから `ask mimamori-flutter: ...` → **「2 件あります」エラー**
   （同名プロジェクトが 3 件存在: gmail 所有 2 件・yahoo 所有 1 件）
6. エラーの案内どおり gmail 側のプロジェクトを `mimamori-win` にリネーム → **まだ 2 件のまま**
   （後述バグ1）
7. 衝突するプロジェクトを一時的に Team から外して再試行 → **成功**
   - `CrossTeamAuditLog` に `invite_sent` → `invite_accepted` → `request` → `completed` の4行
   - `Session.userId`（実行者＝課金先）= yahoo、`Session.requestedByUserId`（依頼者）= gmail
   - `Message.usageData.modelUsage` にコストが記録され、**yahoo 側に $0.275 相当が計上**
     されたことを確認（gmail が質問し、yahoo の契約で実行された、という設計の直接証拠）

## 発見・修正したバグ

### バグ1: 同名衝突エラーの案内「表示名を変えて一意にする」が機能しない

`command-handler.ts` の `resolveCrossTargetByName()` の照合が
`label(p) === needle || p.name === needle` という OR 条件で、`name`（ディレクトリ名、
リネームしても不変）を `displayName`（表示名、変更可）の副次キーとして混ぜていた。
そのため `displayName` をいくら変えても `name` 側で一致し続け、エラーメッセージが案内する
解決策がそもそも成立しないケースがあった（今回のように同名が3件あると、どの文字列で検索
しても区別できない組み合わせが生まれる）。

新規 `services/cross-target-name-match.ts` に照合ロジックを純関数として切り出し、
照合キーを「表示名（`displayName ?? name`）ひとつ」に統一した。`displayName` 未設定の
プロジェクトは `label === name` なので挙動は完全に不変。回帰テストは旧ロジックを
手元で再現し「旧ロジックは3件一致／新ロジックは2件」の比較アサーションで直接検証する
（`apps/server/tests/cross-target-name-match.test.mjs`）。

### バグ2: 本番 `apps/server/.env` が実際には読まれていなかった

`dist/index.js` の `import 'dotenv/config'` はパス指定なしなので `process.cwd()` 基準で
`.env` を探すが、pm2 の `devrelay-server` は `exec cwd=/opt/devrelay`（リポジトリルート）
で起動しており、`/opt/devrelay/.env` は存在しなかった。cwd を `/opt/devrelay` にして
dotenv を実行し `ENOENT` を実測で確認。つまり `apps/server/.env` への追記は
**再起動しても反映されない**構造的な罠になっていた（既存キーは pm2 の env スナップショット
から来ていたため、通常運用では気づかれなかった）。

`/opt/devrelay/.env → apps/server/.env` のシンボリックリンクを作成して解決。
dotenv の既定 `override:false` のため既存のスナップショット値は上書きされず無影響。
`.gitignore` の `.env` パターンがシンボリックリンク自体もカバーすることを確認済み。
CLAUDE.md の環境変数セクションと `system-admin.ts` の誤解を招くコメントに実態を追記した。

## 検証

`pnpm build` 全 6 workspace green。`apps/server` の `node --test` 1451/1451
（新規 10 ケース含む、既存含め非退行）。

## 変更ファイル

新規 `apps/server/src/services/cross-target-name-match.ts`、
`apps/server/tests/cross-target-name-match.test.mjs`。
既存 `apps/server/src/services/command-handler.ts`、`apps/server/src/services/system-admin.ts`、
`CLAUDE.md`。インフラ変更（git 管理外）: `/opt/devrelay/.env` シンボリックリンク新規作成。
DB マイグレーション不要、ソースコード変更ありのため `pnpm build` 実行済み、再起動が必要。

## 未解決（別サイクルで対応予定）

- 招待 UI の文言が過剰共有を招く（「チームへの参加を依頼」→ 実際は「自分のプロジェクトを
  差し出す」ことを意味する）
- 貸す側（grantee）に「自分のどのプロジェクトが誰に公開されているか」を見る UI が無い
  （公開型を実装する前の必須条件）
- プロジェクトのリネーム UI が Team ページにしか無く、Team を持たないユーザーはリネーム
  できない
- 同名衝突の解決手段が弱い（`ask <project>@<machine>:` 形式や候補への採番などが必要。
  公開型を入れると他人のプロジェクトが大量に候補へ入るため衝突確率が跳ね上がる）
- 公開型（Team を公開し、同一組織内の利用者が選んで組み込む）は未実装。設計は
  `CrossTeamGrant` に触れず `Team.visibility` + `TeamSubscription` を新設し、
  `decideCrossTeamAccess()` は無改造のまま candidates を増やすだけで実現できる見込み
