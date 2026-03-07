# サービス追加手順書

本番サーバーに新しいサービスを追加する際の汎用手順書。
各ステップを順番に実行し、チェックボックスで進捗を管理する。

---

## 事前情報の整理

新サービス追加前に以下を決めておくこと。

| 項目 | 記入欄 | 例 |
|------|--------|-----|
| サービス名（= Linux ユーザー名） | __________ | clipped |
| Git リポジトリ URL（SSH） | __________ | git@github.com:murata1215/clipped.git |
| 使用ポート番号 | __________ | 3006 |
| 開発ドメイン | __________ | clipped.murata1215.jp |
| 本番ドメイン（予定） | __________ | clipped.app |
| コード配置先 | __________ | /opt/clipped |
| Git ユーザー名 | __________ | murata1215 |
| Git メールアドレス | __________ | fwjg2507@gmail.com |

### 使用済みポート一覧

| ポート | サービス | 備考 |
|--------|---------|------|
| 3000 | pixdraft | draft.pixblog.net |
| 3001-3005 | devrelay | server=3005, web=3001-3004 |
| 3002 | pixblog | pixblog.net（静的サイト、Caddy直配信） |
| 3004 | pixshelf | shelf.pixblog.net |

次に使えるポート: **3006** 以降

---

## Step 1: Linux ユーザー作成

```bash
# devrelay ユーザー等、sudo 権限のあるユーザーで実行
sudo adduser <サービス名>
```

対話プロンプトでパスワードを設定。フルネーム等はエンターでスキップ可。

### 確認

```bash
id <サービス名>
ls /home/<サービス名>/
```

- [ ] ユーザーが作成され、ホームディレクトリが存在する

---

## Step 2: Git SSH 鍵の設定

```bash
# サービスユーザーに切り替え
sudo su - <サービス名>

# SSH 鍵生成（パスフレーズなし）
ssh-keygen -t ed25519 -C "<サービス名>@$(hostname)"
# → Enter 連打で OK

# 公開鍵を表示（この内容をコピー）
cat ~/.ssh/id_ed25519.pub
```

### GitHub に Deploy Key を登録

1. GitHub のリポジトリページ → Settings → Deploy keys → Add deploy key
2. Title: `<サービス名>@<ホスト名>`（例: `clipped@x220-158-18-103`）
3. Key: 上でコピーした公開鍵を貼り付け
4. **「Allow write access」にチェックを入れる**（push に必要）
5. Add key

### 接続テスト

```bash
ssh -T git@github.com
```

`Hi murata1215/...` のようなメッセージが出れば OK。
初回は `Are you sure you want to continue connecting?` と聞かれるので `yes`。

- [ ] SSH 鍵が生成された
- [ ] GitHub Deploy Key に登録済み（Write access 有効）
- [ ] `ssh -T git@github.com` が成功

---

## Step 3: リポジトリ clone & ビルド

```bash
# サービスユーザーのまま実行
# /opt/<サービス名> に clone（sudo 必要な場合あり）
sudo mkdir -p /opt/<サービス名>
sudo chown <サービス名>:<サービス名> /opt/<サービス名>
git clone <リポジトリURL> /opt/<サービス名>

# Git ユーザー設定（リポジトリローカル）
cd /opt/<サービス名>
git config user.name "<Git ユーザー名>"
git config user.email "<Git メールアドレス>"
```

### 依存インストール & ビルド

プロジェクトに応じて実行:

```bash
# Node.js プロジェクトの場合
pnpm install   # or npm install
pnpm build     # or npm run build

# その他のプロジェクトはプロジェクトの README に従う
```

> **Note**: Node.js がまだ入っていない場合は Step 4 の Claude Code インストール時に一緒に入る。
> pnpm が未インストールの場合: `npm install -g pnpm`

- [ ] リポジトリが clone できた
- [ ] Git config が設定された
- [ ] 依存インストールが成功
- [ ] ビルドが成功

---

## Step 4: Claude Code インストール

```bash
# サービスユーザーで実行
npm install -g @anthropic-ai/claude-code

# バージョン確認
claude --version
```

### 初回認証

```bash
claude
```

初回起動時に認証を求められる。以下のいずれか:
- **OAuth 認証**（ブラウザが使える場合）: 表示された URL をブラウザで開いて認証
- **API キー認証**: `ANTHROPIC_API_KEY` 環境変数を設定

```bash
# API キー方式の場合（.bashrc に追記）
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.bashrc
source ~/.bashrc
```

- [ ] Claude Code がインストールされた
- [ ] `claude --version` で確認
- [ ] 初回認証が完了

---

## Step 5: DevRelay Agent インストール

### 5-1. WebUI でマシントークンを生成

1. https://app.devrelay.io にアクセス
2. マシン管理画面でマシンを追加
3. 表示されたトークン（`drl_...`）をコピー

### 5-2. ワンライナーインストール

```bash
# サービスユーザーで実行
curl -fsSL https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.sh | bash -s -- --token <トークン>
```

### 5-3. 確認

```bash
# 設定ファイル確認
cat ~/.devrelay/config.yaml

# Agent ログ確認（ping が出ていれば OK）
tail -f ~/.devrelay/logs/agent.log
# → 💓 Sending app ping (machineId: ...) が表示されれば成功
# Ctrl+C で抜ける
```

- [ ] WebUI でマシンが追加された
- [ ] ワンライナーが正常完了
- [ ] `config.yaml` にトークン・サーバーURL・マシン名が記載されている
- [ ] Agent ログに ping が出ている
- [ ] WebUI でマシンが online 表示

---

## Step 6: Caddy リバースプロキシ設定

### パターン A: 開発ドメイン（推奨）

開発用ドメイン（例: `murata1215.jp`）のワイルドカード DNS を利用する方式。
初回のみ DNS 設定が必要。2サービス目以降は Caddyfile 追加だけで公開できる。

#### 初回のみ: ワイルドカード DNS 設定

DNS 管理画面で以下の A レコードを追加:

```
*.murata1215.jp  →  <サーバーの IP アドレス>
```

これで `clipped.murata1215.jp`、`xxx.murata1215.jp` 等が全てサーバーに向く。

#### Caddyfile にエントリ追加

```bash
sudo vi /etc/caddy/Caddyfile
```

以下を末尾に追加:

```caddyfile
<サービス名>.<開発ドメイン> {
    reverse_proxy localhost:<ポート>
}
```

例:

```caddyfile
clipped.murata1215.jp {
    reverse_proxy localhost:3006
}
```

#### Caddy 再読み込み

```bash
sudo systemctl reload caddy
```

### パターン B: 本番ドメイン取得後の移行

独自ドメインを取得した後の移行手順。

1. **DNS 設定**: 本番ドメインの A レコードをサーバー IP に向ける
2. **Caddyfile 更新**: ドメインを差し替え

```caddyfile
# Before（開発）
clipped.murata1215.jp {
    reverse_proxy localhost:3006
}

# After（本番）
clipped.app {
    reverse_proxy localhost:3006
}
```

3. **（任意）旧ドメインからリダイレクト**:

```caddyfile
clipped.murata1215.jp {
    redir https://clipped.app{uri} permanent
}
```

4. `sudo systemctl reload caddy`

- [ ] Caddyfile にエントリを追加した
- [ ] `sudo systemctl reload caddy` が成功
- [ ] ブラウザから `https://<ドメイン>` でアクセスできる
- [ ] HTTPS 証明書が有効（鍵マークが出る）

---

## Step 7: サービス起動設定

サービスのプロセスを永続化する。プロジェクトに応じて PM2 または systemd を選択。

### 方式 A: PM2（Node.js プロジェクト推奨）

```bash
# サービスユーザーで実行
cd /opt/<サービス名>

# PM2 で起動
pm2 start dist/index.js --name <サービス名>
# or
pm2 start npm --name <サービス名> -- start

# 自動起動設定
pm2 save
pm2 startup
# → 表示されたコマンドを sudo で実行
```

### 方式 B: systemd

```bash
sudo tee /etc/systemd/system/<サービス名>.service << 'EOF'
[Unit]
Description=<サービス名>
After=network.target

[Service]
Type=simple
User=<サービス名>
WorkingDirectory=/opt/<サービス名>
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable <サービス名>
sudo systemctl start <サービス名>
```

### 確認

```bash
# PM2 の場合
pm2 status

# systemd の場合
sudo systemctl status <サービス名>
```

- [ ] サービスプロセスが起動している
- [ ] 自動起動が設定されている

---

## Step 8: Git テストプッシュ

DevRelay 経由での開発ワークフローが動くか確認。

```bash
# サービスユーザーで実行
cd /opt/<サービス名>

# テスト用の小さな変更
echo "# test" >> README.md

git add README.md
git commit -m "test: verify git push from server"
git push

# テスト変更を元に戻す
git revert HEAD --no-edit
git push
```

- [ ] `git push` が成功
- [ ] GitHub にコミットが反映された
- [ ] revert も成功

---

## Step 9: 動作確認チェックリスト

全ステップ完了後の最終確認。

- [ ] サービスがブラウザからアクセスできる（`https://<ドメイン>`）
- [ ] HTTPS が有効（証明書エラーなし）
- [ ] DevRelay Agent が online（WebUI で確認）
- [ ] Discord からコマンドが実行できる
- [ ] Git push/pull が成功する
- [ ] サーバー再起動後もサービスが自動起動する

---

## 付録: 既存サービス一覧

### サーバー構成（x220-158-18-103）

| サービス | Linux ユーザー | ポート | ドメイン | 配置先 |
|---------|---------------|--------|---------|--------|
| DevRelay Server | devrelay | 3005 | devrelay.io | /opt/devrelay |
| DevRelay WebUI | devrelay | (Caddy直配信) | app.devrelay.io | /opt/devrelay/apps/web/dist |
| pixblog | pixblog | (Caddy直配信) | pixblog.net | /opt/pixblog/public |
| pixshelf | pixshelf | 3004 | shelf.pixblog.net | /opt/pixshelf |
| pixdraft | pixdraft | 3000 | draft.pixblog.net | /opt/pixdraft |
| pixnews | pixnews | — | — | /opt/pixnews |

### Caddyfile の場所

```
/etc/caddy/Caddyfile
```

### DevRelay Agent の設定ファイル

```
~/.devrelay/config.yaml    # 各サービスユーザーのホームディレクトリ
~/.devrelay/logs/agent.log  # Agent ログ
```

### DevRelay Agent インストーラー

```
https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.sh
```
