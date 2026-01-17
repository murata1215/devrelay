# DevRelay 開発記録

> **重要**: 機能追加・変更を行ったら、必ずこのファイルを更新すること。
> セッションが落ちても作業内容を引き継げるようにする。

## プロジェクト概要

DevRelay は、メッセージングアプリ（Discord、Telegram、LINE）から AI CLI ツール（Claude Code、Gemini CLI など）をリモート操作できるハブシステム。

```
[Discord/Telegram/LINE] ↔ [Center Server] ↔ [Agent] ↔ [Claude Code/Gemini CLI]
```

## 実装済み機能

### Phase 1: 基本機能 (2026-01-17)

#### 1. Discord Bot 連携
- Discord からのメッセージ受信・送信
- DM およびメンション対応
- コマンドパーサー（`m`, `p`, `q`, `h` など）

#### 2. Linux Agent
- WebSocket でサーバーに接続
- Claude Code の `-p` モードで非対話実行
- `--dangerously-skip-permissions` で権限プロンプトをスキップ

#### 3. セッション管理
- マシン・プロジェクト選択
- セッション開始・終了
- 会話履歴の管理（DevRelay 側で管理、プロンプトに含める）

#### 4. 双方向ファイル転送

##### Claude Code → Discord
- `.devrelay-output/` ディレクトリを監視
- プロンプトに自動で指示を追加：「ユーザーに渡すファイルは `.devrelay-output/` に保存してください」
- 実行完了後にディレクトリからファイルを収集し、Discord に添付

##### Discord → Claude Code
- Discord の添付ファイルをダウンロード
- `.devrelay-files/` ディレクトリに保存
- プロンプトにファイルパスを含めて Claude Code に渡す

#### 5. プロジェクト自動検出
- `CLAUDE.md` ファイルの存在でプロジェクトを自動検出
- 複数ディレクトリのスキャン対応（`projectsDirs` 配列）
- 最大5階層まで再帰検索

#### 6. リアルタイム進捗表示
- `--output-format stream-json --include-partial-messages --verbose` オプション使用
- Claude Code の出力をリアルタイムでパース
- Discord メッセージを8秒ごとに編集して進捗表示
- ツール使用時は「🔧 Readを使用中...」のように表示

#### 7. セキュアなプロセス管理
- プロンプトを stdin 経由で渡す（`ps aux` に表示されない）
- `devrelay-claude` シンボリックリンクでプロセス識別
- 環境変数による識別:
  - `DEVRELAY=1`
  - `DEVRELAY_SESSION_ID=xxx`
  - `DEVRELAY_PROJECT=/path/to/project`

### Phase 1.1: 追加機能 (2026-01-18)

#### 8. クイックコマンド追加
- `c` - 前回の接続先に再接続（Continue）
  - `lastProjectId` を DB（PlatformLink テーブル）に保存
  - オフラインのマシンには接続不可のエラー表示
- `x` - 会話履歴をクリア（Clear）
  - Agent に `server:conversation:clear` メッセージを送信
  - ファイルとメモリ両方をクリア

#### 9. 会話履歴の永続化
- メモリ管理から**ファイル保存**に変更
- 保存先: `プロジェクト/.devrelay/conversation.json`
- 保存内容:
  ```json
  {
    "projectPath": "/path/to/project",
    "lastUpdated": "2026-01-18T...",
    "history": [
      { "role": "user", "content": "...", "timestamp": "..." },
      { "role": "assistant", "content": "...", "timestamp": "..." }
    ]
  }
  ```
- 保存は無制限、Claude に送るのは直近20件のみ（トークン節約）
- Agent 起動時に自動ロード

#### 10. 進捗表示の改善
- プロンプト送信時に進捗メッセージを先に送信
- 8秒ごとにメッセージを編集して経過時間と出力を表示
- 完了時に進捗メッセージを最終結果で置き換え

#### 11. プロジェクト名変更 (DevBridge → DevRelay)
- 既存企業「Devbridge」（Cognizant傘下）との混同を避けるためリネーム
- 変更内容:
  - パッケージ名: `@devbridge/*` → `@devrelay/*`
  - 設定ディレクトリ: `~/.devbridge/` → `~/.devrelay/`
  - 環境変数: `DEVBRIDGE_*` → `DEVRELAY_*`
  - CLI コマンド: `devbridge` → `devrelay`
  - シンボリックリンク: `devbridge-claude` → `devrelay-claude`
  - 出力ディレクトリ: `.devbridge-output/` → `.devrelay-output/`
  - ファイルディレクトリ: `.devbridge-files/` → `.devrelay-files/`
- GitHub リポジトリも `devrelay` にリネーム済み

## アーキテクチャ

### ディレクトリ構造
```
devrelay/
├── apps/
│   └── server/          # Center Server (Fastify + WebSocket)
├── agents/
│   └── linux/           # Linux Agent
├── packages/
│   └── shared/          # 共通型定義
└── CLAUDE.md
```

### 主要ファイル

#### Server
- `apps/server/src/platforms/discord.ts` - Discord Bot
- `apps/server/src/services/agent-manager.ts` - Agent 通信管理
- `apps/server/src/services/session-manager.ts` - セッション管理
- `apps/server/src/services/command-handler.ts` - コマンド処理

#### Agent
- `agents/linux/src/services/connection.ts` - サーバー接続・メッセージ処理
- `agents/linux/src/services/ai-runner.ts` - Claude Code 実行
- `agents/linux/src/services/output-collector.ts` - 出力ファイル収集
- `agents/linux/src/services/file-handler.ts` - 受信ファイル保存
- `agents/linux/src/services/conversation-store.ts` - 会話履歴の永続化

#### Shared
- `packages/shared/src/types.ts` - 共通型定義（FileAttachment など）

## 設定ファイル

### Agent 設定 (`~/.devrelay/config.yaml`)
```yaml
machineName: ubuntu-dev
machineId: ""
serverUrl: ws://localhost:3000/ws/agent
token: machine_xxxxx
projectsDirs:      # 複数ディレクトリ対応
  - /home/user
  - /var/www
aiTools:
  default: claude
  claude:
    command: claude
logLevel: debug
```

### プロジェクト設定 (`~/.devrelay/projects.yaml`)
```yaml
projects:
  - name: devrelay
    path: /home/user/devrelay
    defaultAi: claude
```

## 起動方法

```bash
# Server
cd apps/server && pnpm start

# Agent
cd agents/linux && pnpm start
```

## 今後の課題

- [ ] Telegram / LINE 対応
- [ ] Gemini CLI / Codex / Aider 対応
- [ ] Windows Agent
- [ ] 要約機能（Anthropic API 使用）
- [ ] 複数ユーザー同時接続
- [ ] Agent の自動再接続改善
- [ ] 進捗表示のUI改善（プログレスバーなど）
- [ ] エラーハンドリング強化
