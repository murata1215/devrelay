# SB-1 完了記録と実機検証（2026-11-23、hp630g9）

## 1. SB-1 で作ったもの

| サイクル | commit | 内容 |
|---|---|---|
| SB-1a-1 | 769b821〜0587638 | Sandbox Host（C#、仮想アカウント NT SERVICE\devrelay-sandbox）、管理者用インストールスクリプト、中継プロキシ（127.0.0.1:48711）、status / prep / set-token / selftest |
| SB-1a-1.1 | a15f81b | 実機確認で見つかった不具合の修正（スクリプトの ASCII 化、sc create、IPv6 ルール、-LocalUser 指定、鍵の生成、再インストール、selftest のホスト経由化など） |
| SB-1a-2 | 7bcfa35 | Agent の実行経路への接続。config.yaml の sandbox.projects で指定したプロジェクトを Sandbox で実行 |
| SB-1b | 7d16468 | Project.sandboxEnabled、REST、画面の Sandbox スイッチ、capability sandbox-host、非対応 Agent への送信拒否 |

## 2. 実機で確認できたこと（hp630g9、Windows 11）

- 画面の Sandbox スイッチ ON で、チャットからの実行が nt service\devrelay-sandbox で動く。OFF で開発者の身元（desktop-q43qt7l\fwjg2）に戻る
- 端末モードは Sandbox ON では拒否される
- Linux の Agent のプロジェクトでは、スイッチが押せない表示になる
- Sandbox の身元から、Agent の config.yaml、sandbox-token、agent\.git\config は読めない（対照のプロジェクト内ファイルは読める）
- 開発者が claude に再ログインしても、Sandbox 用トークン（claude setup-token で発行）は有効なまま

## 3. 通信の検証結果（Sandbox ON、宛先は同じ LAN の Ubuntu 機 192.168.32.196）

| 通信 | 開発者の身元 | Sandbox | 理由 |
|---|---|---|---|
| インターネット 443 番への直接接続 | 届く | 止まる | プロセス自身の通信なので、身元単位のルールに当たる |
| 社内 IP・443 以外（TCP 22、DB 接続の想定） | 届く | 止まる | 同上 |
| プロキシ経由・許可リスト外（example.com） | ― | 403 で拒否 | 中継プロキシの許可リスト |
| プロキシ経由・許可リスト内（api.anthropic.com） | ― | 届く | 同上 |
| ファイル共有（SMB、445 番） | 届く（認証で拒否） | **届く（ゲスト共有の一覧を取得できた）** | 通信は Windows 本体（System）が代行するため、身元単位のルールに当たらない |
| ping（ICMP）、名前解決（DNS） | 届く | **届く** | 同上（OS が代行） |

## 4. 認証情報の扱い

- Sandbox は開発者の認証情報を引き継がない（Windows ログイン、資格情報マネージャー、割り当て済みドライブ、git の保存済み認証）
- 渡しているのは Sandbox 用の Claude トークンだけ
- ネットワーク上では、ワークグループではゲスト（匿名）扱い、ドメインではその PC のコンピューターアカウント（PC名$）として認証する
- プロジェクトフォルダの中身（.env、設定ファイル、.git\config に埋め込んだトークンなど）は AI から読める

## 5. 決定事項

- ファイル共有は、現状のままとする。対象のサーバーはすべて認証が必要なため（人間の判断、2026-11-23）
- ただし会社のドメインでは、共有の権限に Everyone / Authenticated Users / Domain Computers が含まれていると、コンピューターアカウントで読めてしまう。会社 PC で、Sandbox から本番の共有に dir を 1 回実行し、拒否されることを確認する

## 6. 未着手・持ち越し

- テスト DB への通信を通す仕組み（許可リスト、PC 単位）。案: 初回インストール時に管理者権限のタスク（タスクスケジューラ）を登録し、Agent の設定で編集した許可先（IP とポート）を、そのタスクがファイアウォールに反映する。設計調査から始める
- AI に Sandbox の制約（通信先の制限、許可先）を伝える仕組み。現状 AI は Sandbox を知らないため、通信失敗をネットワーク障害と誤解しうる
- selftest --network-probe の 2 本目（プロキシ経由で許可リスト外）が「未確認」のまま。許可リスト内への陽性対照が curl exit=35 で失敗するため。チャットからの実行ではプロキシの 403 拒否を確認済み
- projects add のあと、Agent の手動再起動が必要だった
- 再試行時に crossAskScope と terminalMode が抜け落ちる既存の不具合（connection.ts の retryOptions）
- プランの無いスレッドで e, を送ると、AI が「実装するものが無い」と抵抗する。単発のコマンド実行の送り方を検討する
- 返事の冒頭に「String operation failed: substring position is nonsense」が出ることがある（表示まわり、Sandbox とは無関係の見込み）
- claude setup-token の実行で、開発者の claude ログインが切れるかは未確認（直後にログイン切れが起きたが因果は不明）

## 7. 未検証

- 会社 PC（ドメイン参加、会社プロキシ経由）での Sandbox 実行
- ドメイン環境でのファイル共有の認証の挙動
- Devin CLI の Sandbox 実行（SB-3）
- Sandbox からの git push（SB-1 では対象外）
- 強制 ON と一元配布（SB-4）
