# DevBridge 開発記録

## プロジェクト概要

DevBridge は、メッセージングアプリ（Discord、Telegram、LINE）から AI CLI ツール（Claude Code、Gemini CLI など）をリモート操作できるハブシステム。

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
- 会話履歴の管理（DevBridge 側で管理、プロンプトに含める）

#### 4. 双方向ファイル転送

##### Claude Code → Discord
- `.devbridge-output/` ディレクトリを監視
- プロンプトに自動で指示を追加：「ユーザーに渡すファイルは `.devbridge-output/` に保存してください」
- 実行完了後にディレクトリからファイルを収集し、Discord に添付

##### Discord → Claude Code
- Discord の添付ファイルをダウンロード
- `.devbridge-files/` ディレクトリに保存
- プロンプトにファイルパスを含めて Claude Code に渡す

## アーキテクチャ

### ディレクトリ構造
```
devbridge/
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

#### Shared
- `packages/shared/src/types.ts` - 共通型定義（FileAttachment など）

## 設定ファイル

### Agent 設定 (`~/.devbridge/config.yaml`)
```yaml
machineName: ubuntu-dev
machineId: ""
serverUrl: ws://localhost:3000/ws/agent
token: machine_xxxxx
projectsDir: /home/user/projects
aiTools:
  default: claude
  claude:
    command: claude
logLevel: debug
```

### プロジェクト設定 (`~/.devbridge/projects.yaml`)
```yaml
projects:
  - name: devbridge
    path: /home/user/devbridge
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
