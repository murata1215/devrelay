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
  に「PAT の期限切れ・権限不足の可能性」というメッセージを出す。
- 対処は §6 の「推奨: インストーラ再実行」を新しい PAT で再実行するだけ（`--repo-auth-only`）。
- 失効を未然に防ぐため、PAT の有効期限が切れる前に新しい PAT を発行し、全社内機で
  `--repo-auth-only` を順次実行する運用を推奨する。

## 8. トラブルシュート

| 症状 | 確認方法 |
|---|---|
| `u` が更新したはずなのにコードが変わっていない | `~/.devrelay/logs/update.log` の末尾を確認。`!! git fetch failed` / `!! git reset failed` が出ていれば中止されている（Linux/macOS。macOS は exit code 未チェックのため下記の既知の制約を参照） |
| PAT が設定されているか確認したい（値は見ない） | `git config --local --get-urlmatch http.extraHeader "<repoUrl>"` が何か返せば設定済み（値自体は base64 なので画面に出しても PAT は読み取れないが、必要時以外は実行しない） |
| どの URL から clone しているか確認したい | `git -C ~/.devrelay/agent remote get-url origin` |
| chat/ログに PAT が出ていないか不安 | 設計上 URL にも stderr にも PAT は出ない（`http.<url>.extraHeader` は credential helper を経由しないため 401 が発生せず、認証エラーメッセージに PAT 自体は含まれない）。想定外の出力に備えて `update.log`/チャットへの出力前に伏せ字化処理も入れている |

### macOS の既知の制約（本サイクルでは対象外）

macOS 版 Agent は `getExecEnv()` への非対話化 env 注入（`GIT_TERMINAL_PROMPT=0` 等）のみ対応。
Linux 版で行った「`u` の `git fetch`/`git reset` 失敗時に中止する」判定と、detached スクリプト
spawn 前の pre-flight 認証チェックは macOS では未実装のため、PAT 失効時に **静かに古いコード
のまま restart してしまう**可能性がある（成果物ゲート自体は `dist/index.js` の存在チェックのみで、
鮮度は見ていない）。macOS 機で private リポジトリ運用する場合は、PAT 失効後の挙動を
`update.log` で定期的に確認すること。将来サイクルで Linux 同等の exit code チェックを追加する余地がある。
