# 会社 private リポジトリへの Agent clone 対応（個人 ⇄ 会社 2 リモート運用）

本流（開発）は個人 GitHub `murata1215/devrelay`（public）のまま、社内展開用に会社の
private リポジトリ（本書では例として `https://github.com/tisa-devin/devrelay.git` を使う）へ
コピーを置き、**社内の Agent のインストール／自己更新（`u`）だけ**をそこから行う運用の手順書。

- インストーラ本体の配信路は変えない（`install-agent.sh`/`install-agent.ps1` 自体は引き続き
  public の `raw.githubusercontent.com/murata1215/devrelay/main/scripts/...` から取得する）
- clone 先（Agent 自身のソース取得元）だけを `--repo` / `$env:DEVRELAY_REPO_URL` で切り替える
- 認証は **Fine-grained PAT**（対象リポジトリのみ・`Contents: Read` のみ・有効期限を必ず設定）

## 1. PAT の発行

GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens**。

- Resource owner: 会社の Organization（または個人アカウントで private fork している場合は本人）
- Repository access: **Only select repositories** → 対象の private リポジトリ 1 つだけ
- Permissions: **Repository permissions → Contents: Read-only** のみ（それ以外は `No access`）
- Expiration: 必ず設定する（90 日推奨。失効の扱いは §7）

発行された PAT はこの手順でしか使わない。開発者本人の通常の GitHub 認証
（Git Credential Manager 等の `github.com` 全体の資格情報）とは完全に別物であり、
本サイクルの仕組みは **Agent のリポジトリ（`~/.devrelay/agent/.git/config`）にしか効かない**
（`git config --local` の URL スコープ `http.<repoUrl>.extraHeader` のみを使うため、
credential helper を一度も経由せず、本人の資格情報を上書き・干渉しない）。

> **社内サーバーで PAT を 1 か所管理したい場合は §9「サーバー配布方式」を推奨する。**
> 以降 §2〜§8 は PAT を各社員へ個別に渡す「手入力」運用の手順（§9 導入後も手入力 PAT は
> 優先され続けるため、フォールバックとして有効）。

## 2. 個人 ⇄ 会社の 2 リモート clone（開発機）

`/opt/devrelay`（本流の作業ディレクトリ）とは**別のディレクトリ**に用意することを推奨する。

```bash
git clone git@github.com:murata1215/devrelay.git devrelay-company-sync
cd devrelay-company-sync
git remote add company https://github.com/tisa-devin/devrelay.git
git fetch company
git switch -c company-main --track company/main   # 会社専用の作業ブランチ
```

> この `company` remote の認証は、ふだん GitHub を使うのと同じ方法（SSH 鍵 / GCM 等）でよい。
> **push 権限が必要**なので、Agent 用の read-only PAT とは別物。Agent 用の `extraHeader` は
> `~/.devrelay/agent` 限定の設定であり、ここには一切影響しない。

## 3. 同期（個人 main → 会社 main）

```bash
git fetch origin && git fetch company

# 会社 main が個人 main の祖先（会社固有コミットが無い）場合 ＝ 最も安全
git push company origin/main:main

# 会社固有コミットがある場合（§6 の業務ロジック等）
git switch company-main
git merge --no-ff origin/main
git push company company-main:main
```

## 4. 還元（会社 → 個人、cherry-pick）

会社側で直した汎用的な修正を個人リポジトリへ持ち帰る場合。

```bash
git log --oneline origin/main..company-main   # 会社側にだけあるコミットを確認
git switch main
git cherry-pick <sha>
git push origin main
```

**持ち帰り可**: 汎用的なバグ修正・機能追加・テスト・一般論のドキュメント。
**持ち帰り不可**: 会社の org 名・内部ホスト名・社内 proxy 設定・社内固有の env 既定値・
業務ロジック・社内限定の運用手順。**判断に迷ったら持ち帰らない。**

## 5. 同期後の反映

- 社内サーバー（手動、`pm2 restart` は人間が実行）:
  ```bash
  cd /opt/devrelay && git pull && pnpm build
  # pm2 restart devrelay-server は人間が実行
  ```
- 社員 PC: チャットで `u`（`autoUpdate` が ON なら自動）

## 6. 既存インストール機の切替

### 推奨: インストーラ再実行（冪等・検証付き）

```bash
# Linux / macOS
DEVRELAY_REPO_TOKEN=<PAT> curl -fsSL https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.sh \
  | bash -s -- --repo-auth-only --repo https://github.com/tisa-devin/devrelay.git
```
```powershell
# Windows
$env:DEVRELAY_REPO_URL="https://github.com/tisa-devin/devrelay.git"
$env:DEVRELAY_REPO_AUTH_ONLY="1"
irm https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.ps1 | iex
# PAT 未設定なら対話入力（Read-Host -AsSecureString）を求められる
```

`--repo-auth-only`（ps1 は `$env:DEVRELAY_REPO_AUTH_ONLY="1"`）は Node/pnpm チェック・ビルド・
サービス登録・DevRelay トークン検証を一切行わず、以下だけを行う軽量経路:
1. `origin` の URL を `--repo`/`$env:DEVRELAY_REPO_URL` に張り替え（異なる場合のみ）
2. PAT を `.git/config` の `http.<repoUrl>.extraHeader` に書き込み（既存設定は上書き・冪等）
3. `git ls-remote --exit-code origin HEAD` で接続確認し、結果を画面表示

### 手動版（インストーラを使わない場合）

```bash
cd ~/.devrelay/agent
git remote set-url origin https://github.com/tisa-devin/devrelay.git

# PAT は履歴・ps に残さない（read -rs で非表示入力）
read -rs PAT
printf '[http "%s"]\n\textraHeader = Authorization: Basic %s\n' \
  "https://github.com/tisa-devin/devrelay.git" \
  "$(printf 'x-access-token:%s' "$PAT" | base64 | tr -d '\n')" >> .git/config
unset PAT
chmod 600 .git/config
git ls-remote --exit-code origin HEAD >/dev/null && echo OK
```

> `base64 -w0`（GNU base64 の 1 行出力オプション）は macOS の BSD base64 には無いため、
> 両 OS 互換の `base64 | tr -d '\n'` を使うこと（実測で両 OS 同結果になることを確認済み）。

## 7. PAT のローテーション・失効時の対処

- PAT は Fine-grained の性質上、期限切れ・スコープ不足・repo 名違いで `git fetch`/`git pull`/
  `git ls-remote` が失敗する。Agent はこれを検知すると **ハングせず**、既存の Agent を維持したまま
  更新を中止し、チャットと `~/.devrelay/logs/update.log`（Windows は `%APPDATA%\devrelay\logs\update.log`）
  に案内メッセージを出す（Linux/macOS とも、本サイクルで両 OS 同等の判定に揃えた。詳細は §9）。
  - **手入力 PAT 運用**（§2〜§6）の機体: 「PAT を更新した場合は `--repo-auth-only` 付きで
    インストーラーを再実行してください」という文言
  - **サーバー配布運用**（§9）の機体: 「管理者にサーバー側の `.env` の `DEVRELAY_AGENT_REPO_TOKEN`
    更新を依頼してください」という文言（この機体がサーバーから PAT を受け取った実績がある場合のみ）
- 手入力運用の対処は §6 の「推奨: インストーラ再実行」を新しい PAT で再実行するだけ（`--repo-auth-only`）。
  サーバー配布運用の対処は §9 参照（`.env` を書き換えるだけで全機に自動反映される）。
- 失効を未然に防ぐため、PAT の有効期限が切れる前に新しい PAT を発行しておくこと。

## 8. トラブルシュート

| 症状 | 確認方法 |
|---|---|
| `u` が更新したはずなのにコードが変わっていない | `~/.devrelay/logs/update.log` の末尾を確認。`!! git fetch failed` / `!! git reset failed` が出ていれば中止されている（Linux/macOS 同等。本サイクルで macOS も Linux と同じ exit code チェック + pre-flight チェックに揃えた） |
| PAT が設定されているか確認したい（値は見ない） | `git config --local --get-urlmatch http.extraHeader "<repoUrl>"` が何か返せば設定済み（値自体は base64 なので画面に出しても PAT は読み取れないが、必要時以外は実行しない） |
| どの URL から clone しているか確認したい | `git -C ~/.devrelay/agent remote get-url origin` |
| chat/ログに PAT が出ていないか不安 | 設計上 URL にも stderr にも PAT は出ない（`http.<url>.extraHeader` は credential helper を経由しないため 401 が発生せず、認証エラーメッセージに PAT 自体は含まれない）。想定外の出力に備えて `update.log`/チャットへの出力前に伏せ字化処理も入れている |
| サーバー配布された PAT が効いているか確認したい（§9） | `~/.devrelay/logs/update.log` に `[repo-auth] update refresh: applied` または `unchanged` が出ていれば配布済み・反映済み（`skipped` は public 既定 URL または HTTPS/WSS 以外・`failed` は取得失敗） |
| サーバー配布と手入力 PAT が混在したらどちらが使われるか | **サーバー配布が優先**（`u` 実行ごとに最新を取得して `.git/config` を上書きする）。手入力のみ使いたい場合はサーバー `.env` の `DEVRELAY_AGENT_REPO_TOKEN` を未設定にする |

## 9. サーバー配布方式（社内推奨）

読取PATのサーバー配布サイクル（本節を追加したサイクル）で導入。社員 1 人ひとりに PAT の値を
渡さず、**社内サーバーの `.env` に 1 か所設定するだけ**で、認証済み Agent に自動配布する。

### 9.1 前提条件とリスク（必読）

- **`Machine.token`（DevRelay 自身のマシントークン）は DB に平文で保存されている。** つまり
  サーバー配布方式を使う場合、**DB 侵害＝配布中の PAT を奪取できる**ことを意味する
  （手入力運用では PAT は各 Agent PC のローカルにしか存在せず、サーバー DB 侵害では奪われない）。
  このリスクは、本サイクルの実装で意図的に受け入れた前提である（人間判断）。
- このリスクを許容できる前提は **PAT の発行方針を厳守すること**: §1 のとおり
  **Fine-grained・対象リポジトリ 1 つのみ・`Contents: Read-only`・有効期限必須**。
  通常の GitHub アカウント全体に効く PAT や、有効期限なしの PAT は絶対に使わないこと
  （漏えい時の被害を「対象の private リポジトリの読み取りのみ・期限切れで自然失効」に限定する）。
- PAT は **サーバー env（`.env`）にのみ保存**し、**DB には一切保存しない**（WebUI・REST API・
  ログのいずれにも値は出ない。配布経路は下記 9.3 の 2 つのみ）。

### 9.2 設定

`apps/server/.env` に以下を追加し、`pm2 restart devrelay-server`（人間が実行）:

```
DEVRELAY_AGENT_REPO_URL=https://github.com/tisa-devin/devrelay.git
DEVRELAY_AGENT_REPO_TOKEN=<Fine-grained PAT>
```

- `DEVRELAY_AGENT_REPO_TOKEN` は `DEVRELAY_AGENT_REPO_URL` とセットのときのみ有効（片方だけでは配布しない）
- PAT は印字可能 ASCII のみ・20〜255 文字の範囲外・改行等の制御文字を含む場合は
  サーバーが自動的に無視する（`resolveAgentRepoToken()`、値はログに出さず警告のみ）
- 個人の devrelay.io にはこの env を設定しないため、個人環境には一切影響しない

### 9.3 配布経路（2 つ、どちらも認証済み Agent 限定）

1. **インストール時（HTTP）**: インストーラー（`install-agent.sh`/`.ps1`）が
   `POST /api/agent/repo-auth`（`Authorization: Bearer <machine token>`）を叩き、応答の
   `authHeader` をそのまま `.git/config` に書く。手入力 PAT（`$DEVRELAY_REPO_TOKEN`/対話入力）が
   指定されていればそちらが優先され、サーバーには問い合わせない。
2. **`u`（自己更新）実行前（WS、ローテーション反映）**: Agent が `handleVersionCheck()`/
   `handleAgentUpdate()` の最初に `agent:repo:auth:request` をサーバーに送り、`server:repo:auth`
   で最新の PAT を受け取って `.git/config` を更新する。**origin が public 既定 URL の機体は
   一切問い合わせない**（個人 devrelay.io を含む既存の全環境は新しい通信が増えない）。

どちらの経路も、サーバーは生 PAT ではなく `Authorization: Basic <base64>` 形式のヘッダ値を返す
（クライアント側は base64 化や `x-access-token:` 規約を再現しなくてよい）。

### 9.4 優先順位（手入力 vs サーバー配布）

| 場面 | 優先順位 |
|---|---|
| インストール時 | 手入力 PAT（`$DEVRELAY_REPO_TOKEN`/対話入力）> サーバー配布 > （どちらも無ければ public clone） |
| `u` 実行時 | **サーバー配布が常に勝つ**（取得できた場合は `.git/config` を上書きする）。サーバーが無応答・
  未設定・タイムアウト（5秒）の場合は既存のローカル設定（手入力 PAT 含む）を一切変更しない |

### 9.5 ローテーション手順

1. 管理者が `apps/server/.env` の `DEVRELAY_AGENT_REPO_TOKEN` を新しい PAT に書き換える
2. `pm2 restart devrelay-server`（人間が実行）
3. 各 Agent は**次回の `u`（または自動更新）実行時に自動的に新 PAT を取り込む**（追加作業不要）
4. 急ぎの場合は対象機で `--repo-auth-only --repo <URL>` を実行すると即時反映される
   （手入力 PAT を渡さなければ、インストーラーがサーバーから自動取得する）

### 9.6 対象外

- `agents/windows`（Electron GUI 版）は対象外（§6 の手入力運用のみ、サーバー配布は未対応）
- PAT の DB 管理・WebUI からの設定画面（`.env` 直接編集のみ）
- ユーザー単位・組織単位での PAT 出し分け（サーバー全体で 1 つの PAT のみ）
