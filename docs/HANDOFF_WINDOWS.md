# 🪟 Windows部隊 引き継ぎ指示書

## 📋 概要

DevBridgeプロジェクトのWindows Agent開発を担当。
Linux Agentとは**別リポジトリ**で開発し、共通の型定義のみ共有。

---

## 🎯 担当範囲

1. **Windows Agent** - 新規作成
2. **Windowsインストーラ** - MSI or PowerShellスクリプト
3. **システムトレイアプリ**（オプション）

---

## 📦 リポジトリ構成

```
devbridge-agent-windows/
├── src/
│   ├── index.ts              # エントリポイント
│   ├── services/
│   │   ├── config.ts         # 設定管理
│   │   ├── connection.ts     # WebSocket接続
│   │   ├── projects.ts       # プロジェクト管理
│   │   └── ai-runner.ts      # AI CLI実行
│   └── cli/
│       └── commands/         # CLIコマンド
├── tray/                     # システムトレイアプリ（オプション）
├── installer/                # インストーラ
├── package.json
└── tsconfig.json
```

---

## 🔧 開発開始手順

### 1. リポジトリ作成

```powershell
mkdir devbridge-agent-windows
cd devbridge-agent-windows
npm init -y
```

### 2. 依存関係

```json
{
  "name": "@devbridge/agent-windows",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "bin": {
    "devbridge": "./dist/cli/index.js"
  },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "ws": "^8.16.0",
    "yaml": "^2.3.4",
    "commander": "^12.0.0",
    "nanoid": "^5.0.4"
  },
  "devDependencies": {
    "@types/node": "^20.10.0",
    "@types/ws": "^8.5.10",
    "typescript": "^5.3.0",
    "tsx": "^4.7.0"
  }
}
```

### 3. 共通型定義のコピー

Linux側の `packages/shared/src/types.ts` と `constants.ts` をコピーして使用。
（npmパッケージ化は将来検討）

```powershell
# Linux側からコピー
mkdir src/shared
# types.ts, constants.ts をコピー
```

---

## 📁 Linux Agentとの差異

### 同じにすべき部分
- WebSocketプロトコル（メッセージ形式）
- 設定ファイル形式（config.yaml, projects.yaml）
- CLIコマンド体系

### Windowsで異なる部分

| 項目 | Linux | Windows |
|------|-------|---------|
| 設定ディレクトリ | `~/.devbridge/` | `%USERPROFILE%\.devbridge\` |
| サービス | systemd | Windows Service |
| インストーラ | install.sh | install.ps1 or MSI |
| パス区切り | `/` | `\` |
| AI CLIコマンド | `claude` | `claude.cmd` or `claude.exe` |

---

## 🛠 実装タスク

### 必須タスク

#### 1. 設定管理 (`src/services/config.ts`)
```typescript
// Windowsパス対応
const CONFIG_DIR = path.join(process.env.USERPROFILE || '', '.devbridge');
```

#### 2. WebSocket接続 (`src/services/connection.ts`)
```typescript
// Linux版をそのまま流用可能
// プロトコルは同じ
```

#### 3. AI実行 (`src/services/ai-runner.ts`)
```typescript
// Windows用にspawnオプション調整
const proc = spawn(command, args, {
  cwd: projectPath,
  shell: true,  // Windowsではtrue推奨
  env: process.env,
});
```

#### 4. CLI (`src/cli/`)
```typescript
// Linux版をベースに
// パス処理をWindows対応に
```

#### 5. インストーラ (`installer/install.ps1`)
```powershell
# PowerShellインストーラ
# - Node.js確認
# - ダウンロード・配置
# - 環境変数PATH追加
# - 初期設定
```

### オプションタスク

#### システムトレイアプリ (`tray/`)
- Electron or .NET WinForms
- 接続状態表示
- 起動/停止
- ログ表示

#### Windows Service
- node-windows or NSSM使用
- 自動起動設定

---

## 📋 WebSocketプロトコル（参照用）

### Agent → Server

```typescript
// 接続
{ type: 'agent:connect', payload: { machineId, machineName, token, projects, availableAiTools } }

// 切断
{ type: 'agent:disconnect', payload: { machineId } }

// プロジェクト更新
{ type: 'agent:projects', payload: { machineId, projects } }

// AI出力
{ type: 'agent:ai:output', payload: { machineId, sessionId, output, isComplete } }

// AIステータス
{ type: 'agent:ai:status', payload: { machineId, sessionId, status, error? } }
```

### Server → Agent

```typescript
// 接続確認
{ type: 'server:connect:ack', payload: { success, error? } }

// セッション開始
{ type: 'server:session:start', payload: { sessionId, projectName, projectPath, aiTool } }

// セッション終了
{ type: 'server:session:end', payload: { sessionId } }

// プロンプト
{ type: 'server:ai:prompt', payload: { sessionId, prompt, userId } }
```

---

## 🧪 テスト手順

### 1. ローカルサーバー接続テスト
```powershell
# Ubuntu部隊のサーバーに接続
# config.yaml の serverUrl を設定
# トークンはサーバーDBで発行

devbridge start
# → 接続成功を確認
```

### 2. AI実行テスト
```powershell
# Claude Codeインストール済みの環境で
# プロジェクト登録
devbridge projects add C:\Users\xxx\projects\my-app

# 接続テスト
# Discordから操作して動作確認
```

---

## 📞 Ubuntu部隊との連携ポイント

### 型定義の同期
- `types.ts` を変更する場合は相互に連絡
- プロトコル変更は両部隊で同時対応

### テスト環境
- Ubuntu部隊のサーバーに接続してテスト可能
- サーバーURL・トークンは要連絡

### 問題発生時
- WebSocket接続問題 → サーバーログと突き合わせ
- プロトコル不整合 → 型定義を再確認

---

## 🐛 Windows固有の注意点

### パス区切り
```typescript
// NG
const configPath = homeDir + '/.devbridge/config.yaml';

// OK
const configPath = path.join(homeDir, '.devbridge', 'config.yaml');
```

### 改行コード
```typescript
// WebSocket送受信時はLF統一
const normalized = output.replace(/\r\n/g, '\n');
```

### プロセス終了
```typescript
// Windowsでは SIGTERM が効かないことがある
proc.kill(); // デフォルト
// または
process.kill(proc.pid, 'SIGKILL');
```

### 管理者権限
- インストーラは管理者権限不要を目指す
- ユーザーディレクトリにインストール
- PATHはユーザー環境変数に追加

---

## 📝 完了報告時に含めてほしい情報

1. リポジトリURL
2. 動作確認環境（Windows版）
3. インストール手順
4. 発見した問題・対処
5. システムトレイアプリの有無
6. Windows Service対応状況
