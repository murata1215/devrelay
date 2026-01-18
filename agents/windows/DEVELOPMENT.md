# Windows Agent 開発指示書

## 概要

Linux Agent (`agents/linux/`) をベースに Windows 版 Agent を開発する。
基本的なロジックは Linux 版と同じだが、OS 固有の違いに対応する。

## ディレクトリ構造

```
agents/
├── linux/           # 既存の Linux Agent
└── windows/         # 新規作成
    ├── src/
    │   ├── cli/
    │   │   ├── commands/
    │   │   │   ├── setup.ts      # Windows 用セットアップ
    │   │   │   ├── uninstall.ts  # Windows 用アンインストール
    │   │   │   ├── start.ts
    │   │   │   └── status.ts
    │   │   └── index.ts
    │   ├── services/
    │   │   ├── config.ts         # Windows パス対応
    │   │   ├── connection.ts     # そのまま流用可
    │   │   ├── ai-runner.ts      # Windows プロセス管理
    │   │   ├── output-collector.ts
    │   │   ├── file-handler.ts
    │   │   ├── conversation-store.ts
    │   │   └── project-scanner.ts
    │   └── index.ts
    ├── package.json
    ├── tsconfig.json
    └── DEVELOPMENT.md
```

## Linux との主な違い

### 1. 設定ディレクトリ

| Linux | Windows |
|-------|---------|
| `~/.devrelay/` | `%APPDATA%\devrelay\` |
| `~/.devrelay/config.yaml` | `%APPDATA%\devrelay\config.yaml` |
| `~/.devrelay/logs/` | `%APPDATA%\devrelay\logs\` |

```typescript
// config.ts
import os from 'os';
import path from 'path';

const CONFIG_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || os.homedir(), 'devrelay')
  : path.join(os.homedir(), '.devrelay');
```

### 2. プロジェクトディレクトリのデフォルト

| Linux | Windows |
|-------|---------|
| `/home/user` | `C:\Users\username` |

```typescript
const defaultProjectsDirs = [os.homedir()];
```

### 3. サービス化

Linux は systemd を使用するが、Windows は以下の選択肢がある:

#### 選択肢 A: Windows Service (推奨)
- `node-windows` パッケージを使用
- 管理者権限が必要
- OS 起動時に自動実行

```typescript
import { Service } from 'node-windows';

const svc = new Service({
  name: 'DevRelay Agent',
  description: 'DevRelay Agent for remote AI CLI control',
  script: path.join(__dirname, 'index.js'),
});

svc.on('install', () => svc.start());
svc.install();
```

#### 選択肢 B: スタートアップ登録
- 管理者権限不要
- ユーザーログイン時に自動実行
- `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\` にショートカット作成

```typescript
import { execSync } from 'child_process';

// VBScript でショートカット作成
const startupPath = path.join(
  process.env.APPDATA!,
  'Microsoft\\Windows\\Start Menu\\Programs\\Startup',
  'devrelay-agent.vbs'
);

const vbsContent = `
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """${process.execPath}"" ""${agentScript}""", 0, False
`;

fs.writeFileSync(startupPath, vbsContent);
```

#### 選択肢 C: タスクスケジューラ
- 管理者権限が必要な場合あり
- 柔軟なスケジュール設定

### 4. プロセス管理

#### Claude Code 実行
- Linux: シンボリックリンク `devrelay-claude` を作成
- Windows: シンボリックリンクは管理者権限が必要なので、直接 `claude.cmd` を使用

```typescript
// ai-runner.ts
const claudeCommand = process.platform === 'win32'
  ? 'claude.cmd'  // Windows では .cmd 拡張子
  : 'claude';

// which コマンドの代替
const findClaudeCommand = process.platform === 'win32'
  ? 'where claude'
  : 'which claude';
```

#### プロセス識別
- Linux: `DEVRELAY=1` 環境変数 + `ps aux` でフィルタ
- Windows: 同じ環境変数を使用、`tasklist` または `wmic` でフィルタ

### 5. パス区切り

Node.js の `path` モジュールを使えば自動的に対応される。
ハードコードされた `/` は避けて `path.join()` を使用する。

```typescript
// NG
const configPath = homeDir + '/.devrelay/config.yaml';

// OK
const configPath = path.join(CONFIG_DIR, 'config.yaml');
```

### 6. 改行コード

- Linux: `\n`
- Windows: `\r\n`

ファイル出力時は `os.EOL` を使用するか、明示的に `\n` を使用する（Git が自動変換するため）。

## 実装手順

### Phase 1: 基本構造

1. **ディレクトリ作成**
   ```bash
   mkdir -p agents/windows/src/{cli/commands,services}
   ```

2. **package.json 作成**
   - Linux 版をコピーして修正
   - `name`: `@devrelay/agent-windows`
   - 依存関係に `node-windows` を追加

3. **tsconfig.json 作成**
   - Linux 版をそのまま使用可

### Phase 2: 設定管理

1. **config.ts** を Windows パス対応に修正
   - `CONFIG_DIR` を `%APPDATA%\devrelay` に
   - デフォルト `serverUrl` は `wss://ribbon-re.jp/devrelay-api/ws/agent`

2. **テスト**
   - 設定ファイルの読み書き
   - ディレクトリ自動作成

### Phase 3: 接続・通信

1. **connection.ts** をコピー
   - ほぼそのまま動作するはず
   - WebSocket は OS 非依存

2. **conversation-store.ts** をコピー
   - パス区切り以外は同じ

### Phase 4: AI 実行

1. **ai-runner.ts** を Windows 対応
   - `claude.cmd` を使用
   - プロセス spawn のオプション調整
   - stdin 経由のプロンプト渡しは同じ

2. **output-collector.ts** をコピー
   - ほぼそのまま動作

### Phase 5: CLI

1. **setup.ts** を Windows 対応
   - サービス化の選択肢を変更
   - Windows Service または スタートアップ登録

2. **uninstall.ts** を Windows 対応
   - サービス削除
   - 設定ディレクトリ削除

### Phase 6: テスト

1. Windows 環境でビルド・実行
2. サーバーへの接続確認
3. Claude Code 実行確認
4. サービス化確認

## 注意点

### トークン・セキュリティ
- Linux 版と同じトークン形式を使用
- 設定ファイルの権限は Windows ACL で制限（オプション）

### エラーハンドリング
- Windows 固有のエラーコード対応
- ファイルロック（Windows はファイルロックが厳しい）

### ログ
- イベントログへの出力も検討（Windows Service の場合）

### テスト環境
- Windows 10/11 で動作確認
- PowerShell と cmd.exe 両方で動作確認

## Linux Agent からのコピー対象

そのまま使えるファイル:
- `connection.ts` - WebSocket 通信（OS 非依存）
- `conversation-store.ts` - 会話履歴管理
- `output-collector.ts` - ファイル収集
- `file-handler.ts` - ファイル保存
- `project-scanner.ts` - プロジェクト検出

修正が必要なファイル:
- `config.ts` - パス、デフォルト値
- `ai-runner.ts` - プロセス管理
- `setup.ts` - サービス化
- `uninstall.ts` - アンインストール

## コマンド

```powershell
# セットアップ
devrelay setup

# 手動起動
devrelay start

# ステータス確認
devrelay status

# アンインストール
devrelay uninstall
```

## 参考: Linux Agent の主要ファイル

```
agents/linux/src/
├── cli/
│   ├── commands/
│   │   ├── setup.ts        # 140行程度
│   │   ├── uninstall.ts    # 100行程度
│   │   ├── start.ts        # 30行程度
│   │   └── status.ts       # 20行程度
│   └── index.ts            # 30行程度
├── services/
│   ├── config.ts           # 120行程度
│   ├── connection.ts       # 200行程度
│   ├── ai-runner.ts        # 250行程度
│   ├── output-collector.ts # 80行程度
│   ├── file-handler.ts     # 50行程度
│   ├── conversation-store.ts # 150行程度
│   └── project-scanner.ts  # 80行程度
└── index.ts                # 100行程度
```

## 完了条件

- [ ] Windows で `devrelay setup` が動作
- [ ] サーバーに接続して WebUI でオンライン表示
- [ ] Discord/Telegram からプロンプト送信→Claude Code 実行→結果返却
- [ ] ファイル転送（双方向）が動作
- [ ] `devrelay uninstall` でクリーンアンインストール
- [ ] Windows Service または スタートアップ登録で自動起動
