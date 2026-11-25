# Windows Sandbox セットアップ

この手順は、Windows の DevRelay Agent で Sandbox を使う開発者 PC 向けです。Sandbox を ON にしても、ここでの準備が終わるまでチャットの実行は拒否されます。画面のスイッチを押せることと、実行できることは別です。

チャットの拒否文には、この PC の Node・Agent・プロジェクトの実パスを入れたコマンドが表示されます。表示されたコマンドを優先して使ってください。

## 1. 管理者: Sandbox Host を導入する

DevRelay リポジトリを取得済みの Windows PC で、**管理者として起動した PowerShell** を開きます。開発者アカウントを明示して次を実行します。

```powershell
Set-Location 'C:\dev\devrelay'
.\scripts\install-sandbox-host.ps1 -DeveloperAccount 'PC名\開発者アカウント'
```

この操作は Windows サービス、ファイアウォール規則、許可リストを反映するタスクを導入します。既存の導入を更新・修復するときも同じスクリプトを再実行します。

## 2. 開発者: Sandbox 用トークンを登録する

**通常の（管理者ではない）PowerShell** で、チャットの拒否文に表示されたコマンドを実行します。例:

```powershell
& 'C:\Users\<user>\AppData\Roaming\devrelay\node\node.exe' 'C:\Users\<user>\AppData\Roaming\devrelay\agent\dist\cli\index.js' sandbox set-token
```

表示に従い、`claude setup-token` で発行した値を貼り付けます。トークンを `config.yaml`、チャット、記録ファイルに書かないでください。

## 3. 開発者: プロジェクトを置き、Sandbox 権限を準備する

プロジェクトは `C:\Users\...` のホーム配下ではなく、たとえば `C:\dev\my-project` に置きます。Git リポジトリであることを確認してから、**通常の PowerShell** で次を実行します。

```powershell
& 'C:\Users\<user>\AppData\Roaming\devrelay\node\node.exe' 'C:\Users\<user>\AppData\Roaming\devrelay\agent\dist\cli\index.js' sandbox prep --project 'C:\dev\my-project'
```

`sandbox prep` は Sandbox Host が Claude 実行ファイルとプロジェクトへ必要な範囲だけアクセスできるようにします。別のプロジェクトを Sandbox で使うときは、そのプロジェクトごとに実行します。

## 4. 開発者: 許可リストを設定する（必要な場合だけ）

`%APPDATA%\devrelay\config.yaml` の `sandbox` に設定します。`allowlist` は中継プロキシ経由のドメイン、`allowDestinations` は直接接続が必要な IPv4 アドレスと TCP ポートです。

```yaml
sandbox:
  projects: [ "C:\\dev\\my-project" ]
  allowlist: [ "api.anthropic.com:443" ]
  allowDestinations: [ "10.1.200.1:1521" ]
```

`allowDestinations` は `IPv4:ポート` 形式だけです。1〜65535 のポートを指定し、最大20件にします。未設定または空の場合は直接通信を許可しません。保存後の反映は Agent が行います。反映待ちの拒否が出たら少し待って再送し、失敗が続く場合は管理者が手順1を再実行してください。

## 5. 開発者: 状態を確認する

**通常の PowerShell** で、対象プロジェクトを指定して確認します。

```powershell
& 'C:\Users\<user>\AppData\Roaming\devrelay\node\node.exe' 'C:\Users\<user>\AppData\Roaming\devrelay\agent\dist\cli\index.js' sandbox status --project 'C:\dev\my-project'
```

最後に `✅ Sandbox 実行の前提は満たされています。` と出れば準備完了です。失敗時は表示された拒否文の最初の手順だけを先に行ってから、もう一度確認してください。

## アンインストール

不要になった場合は、**管理者として起動した PowerShell** でリポジトリから実行します。

```powershell
Set-Location 'C:\dev\devrelay'
.\scripts\uninstall-sandbox-host.ps1
```

サービス、Sandbox のファイアウォール規則、許可リスト反映タスクと `C:\ProgramData\devrelay\sandbox` を削除します。開発者側の `config.yaml` と Sandbox 用トークンは削除しません。
