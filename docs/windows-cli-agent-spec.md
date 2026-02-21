# Windows CLI Agent 仕様書

## 概要

Windows 向けの軽量 CLI Agent を実装する。現行の Electron タスクトレイアプリ（`agents/windows/`）はメモリ ~150MB・インストールサイズ ~200MB と重いため、Linux Agent と同じ CLI ベースの軽量版を提供する。

**目標**: Linux Agent のコードを Windows 対応に拡張し、PowerShell ワンライナーでインストール可能にする。

## アーキテクチャ

### 方針: Linux Agent を Windows 対応に拡張（単一コードベース）

`agents/linux/` を `agents/linux/` のまま、**Windows でも動作するように拡張する**。

```
変更前: agents/linux/ → Linux 専用
変更後: agents/linux/ → Linux + Windows 対応（クロスプラットフォーム）
```

パッケージ名も `@devrelay/agent-linux` → `@devrelay/agent` にリネーム。

**理由**:
- Linux Agent の services/ は 90% がプラットフォーム非依存（WebSocket、AI実行、会話履歴、ファイル転送）
- Windows 固有の処理はごく一部（設定ディレクトリパス、Claude Code パス解決、サービス管理）
- コードの重複を排除し、機能追加時に1箇所の修正で済むようにする

### 変更が必要な箇所

| ファイル | 変更内容 |
|---------|---------|
| `services/config.ts` | 設定ディレクトリを OS 判定で切り替え |
| `services/ai-runner.ts` | `which` → `where`（Windows）の Claude Code パス解決 |
| `cli/commands/setup.ts` | systemd → Windows サービス化（nssm or タスクスケジューラ）分岐 |
| `cli/commands/uninstall.ts` | Windows 向けクリーンアップ |
| `index.ts` | 変更不要（Node.js は OS 非依存） |
| `services/connection.ts` | 変更不要 |
| `services/conversation-store.ts` | 変更不要 |
| `services/output-collector.ts` | 変更不要 |

### 設定ディレクトリ

```typescript
// services/config.ts
const CONFIG_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'devrelay')
  : path.join(os.homedir(), '.devrelay');
```

| OS | パス |
|----|------|
| Linux | `~/.devrelay/config.yaml` |
| Windows | `%APPDATA%\devrelay\config.yaml` |

### デフォルト projectsDirs

```typescript
const defaultProjectsDirs = process.platform === 'win32'
  ? [os.homedir()]
  : [os.homedir(), '/opt'];
```

### Claude Code パス解決

```typescript
// services/ai-runner.ts
async function resolveClaudePath(): Promise<string> {
  const binDir = path.join(CONFIG_DIR, 'bin');
  const symlinkName = process.platform === 'win32' ? 'devrelay-claude.cmd' : 'devrelay-claude';
  const symlinkPath = path.join(binDir, symlinkName);

  if (existsSync(symlinkPath)) return symlinkPath;

  // フォールバック: which (Linux) / where (Windows)
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const result = execSync(`${cmd} claude`, { encoding: 'utf-8' }).trim();
  // ...
}
```

## Windows ワンライナーインストーラー

### 使い方

```powershell
irm https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.ps1 | iex
```

トークン付き（環境変数経由）:
```powershell
$env:DEVRELAY_TOKEN="drl_xxxx_yyyy"; irm https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.ps1 | iex
```

### スクリプト処理フロー (`scripts/install-agent.ps1`)

```
Step 1: 依存ツール確認
  - Node.js 20+ → なければエラー + インストール方法案内
  - git → なければエラー + インストール方法案内
  - pnpm → なければエラー + インストール方法案内

Step 2: リポジトリ取得
  - git clone --depth 1 → %APPDATA%\devrelay\agent\

Step 3: ビルド
  - pnpm install → pnpm --filter @devrelay/shared build → pnpm --filter @devrelay/agent build

Step 4: config.yaml 生成
  - %APPDATA%\devrelay\config.yaml
  - machineName: "$env:COMPUTERNAME/$env:USERNAME"

Step 5: devrelay-claude シンボリックリンク
  - where claude → %APPDATA%\devrelay\bin\devrelay-claude.cmd

Step 6: バックグラウンド起動 + 自動起動設定
  - タスクスケジューラ でログオン時自動起動を登録
  - Start-Process で即座にバックグラウンド起動
```

### 依存チェックのエラーメッセージ

```
❌ Node.js 20 以上が必要です
   インストール: winget install OpenJS.NodeJS.LTS
   または: https://nodejs.org

❌ git が必要です
   インストール: winget install Git.Git

❌ pnpm が必要です
   インストール: npm install -g pnpm
```

### Windows 自動起動: タスクスケジューラ

nssm（外部ツール）やレジストリ直接操作ではなく、**タスクスケジューラ** を使う。

```powershell
# タスクスケジューラでログオン時に自動起動
$action = New-ScheduledTaskAction -Execute "node" -Argument "$AgentDir\agents\linux\dist\index.js" -WorkingDirectory "$AgentDir\agents\linux"
$trigger = New-ScheduledTaskTrigger -AtLogon
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName "DevRelay Agent" -Action $action -Trigger $trigger -Settings $settings -Description "DevRelay Agent - Remote AI CLI Hub"
```

**タスクスケジューラのメリット**:
- Windows 標準機能（外部ツール不要）
- `schtasks /query /tn "DevRelay Agent"` でステータス確認可能
- GUI（タスクスケジューラ）からも管理可能
- ログオン時自動起動が簡単

### アンインストール

```powershell
# タスクスケジューラから削除
Unregister-ScheduledTask -TaskName "DevRelay Agent" -Confirm:$false

# プロセス停止
Get-Process -Name "node" | Where-Object { $_.CommandLine -like "*devrelay*" } | Stop-Process

# ディレクトリ削除
Remove-Item -Recurse -Force "$env:APPDATA\devrelay"
```

## WebUI のワンライナー表示

Agent 追加モーダルで OS 別にワンライナーを切り替え表示する。

```
┌─ Quick Install ────────────────────────────────┐
│                                                 │
│  [Linux]  [Windows]   ← タブ切り替え             │
│                                                 │
│  Linux タブ:                                     │
│  curl -fsSL https://... | bash -s -- --token XX │
│                                      [📋 Copy]  │
│                                                 │
│  Windows タブ:                                   │
│  $env:DEVRELAY_TOKEN="XX"; irm https://... | iex│
│                                      [📋 Copy]  │
│                                                 │
│  前提条件: Node.js 20+, git, pnpm               │
│                                                 │
└─────────────────────────────────────────────────┘
```

## Electron Agent との棲み分け

| 機能 | CLI Agent (新) | Electron Agent (既存) |
|------|---------------|---------------------|
| メモリ使用量 | ~50MB | ~150MB |
| インストールサイズ | ~30MB (clone) | ~200MB (exe) |
| インストール方法 | ワンライナー | インストーラー (.exe) |
| タスクトレイ | なし | あり |
| 設定画面 GUI | なし (config.yaml) | あり (HTML) |
| スリープ防止 | なし | あり (kernel32.dll) |
| 接続状態表示 | ログのみ | トレイアイコン色 |
| 自動起動 | タスクスケジューラ | レジストリ |
| ターゲットユーザー | 開発者・サーバー管理者 | 一般ユーザー |

**Electron Agent は廃止しない**。GUI が欲しいユーザー向けに維持する。

## 実装ステップ

### Phase 1: Linux Agent のクロスプラットフォーム化
1. `agents/linux/src/services/config.ts` に Windows パス対応を追加
2. `agents/linux/src/services/ai-runner.ts` の Claude Code パス解決を Windows 対応
3. `agents/linux/src/cli/commands/setup.ts` に Windows 向けセットアップ分岐を追加
4. `agents/linux/src/cli/commands/uninstall.ts` に Windows 向けクリーンアップを追加
5. パッケージ名を `@devrelay/agent` にリネーム（オプション、後回し可）

### Phase 2: PowerShell インストーラー
6. `scripts/install-agent.ps1` を作成
7. WebUI のモーダルに Windows タブを追加（`apps/web/src/pages/MachinesPage.tsx`）

### Phase 3: テスト・ドキュメント
8. Windows 環境でのインストール・起動テスト
9. CLAUDE.md / README.md の更新

## 注意事項

- `agents/windows/`（Electron版）は変更しない
- `agents/linux/` の既存の Linux 動作に影響を与えないこと
- `process.platform === 'win32'` での分岐は最小限にし、可能な限り Node.js の標準 API で OS 差を吸収する
- `path` モジュール（`path.join`, `path.resolve`）は自動的に OS 対応のパス区切りを使うため、明示的なパス操作は不要
