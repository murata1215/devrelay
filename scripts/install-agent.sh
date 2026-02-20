#!/bin/bash

# =============================================================================
# DevRelay Agent ワンライナーインストーラー
# =============================================================================
#
# 使い方:
#   curl -fsSL https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.sh | bash -s -- --token YOUR_TOKEN
#
# 前提条件:
#   - Node.js 20+
#   - git
#   - systemd (Linux)
#
# 処理内容:
#   1. 依存ツールの確認（Node.js 20+, git, npm）
#   2. リポジトリを ~/.devrelay/agent/ に clone（既存なら git pull）
#   3. pnpm をインストールし、shared + agent をビルド
#   4. config.yaml を自動生成（machineName = hostname/username）
#   5. devrelay-claude シンボリックリンク作成（claude があれば）
#   6. systemd ユーザーサービスを登録・起動・linger 有効化
# =============================================================================

set -e

# --- 色定義 ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# --- 定数 ---
REPO_URL="https://github.com/murata1215/devrelay.git"
AGENT_DIR="$HOME/.devrelay/agent"
CONFIG_DIR="$HOME/.devrelay"
CONFIG_FILE="$CONFIG_DIR/config.yaml"
SERVICE_NAME="devrelay-agent"

# --- 引数パース ---
TOKEN=""
SERVER_URL="wss://ribbon-re.jp/devrelay-api/ws/agent"

while [[ $# -gt 0 ]]; do
  case $1 in
    --token)
      TOKEN="$2"
      shift 2
      ;;
    --server)
      SERVER_URL="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: $0 --token YOUR_TOKEN [--server SERVER_URL]"
      echo ""
      echo "Options:"
      echo "  --token   (必須) WebUI で生成したエージェントトークン"
      echo "  --server  サーバーURL (デフォルト: wss://ribbon-re.jp/devrelay-api/ws/agent)"
      exit 0
      ;;
    *)
      echo -e "${RED}不明な引数: $1${NC}"
      exit 1
      ;;
  esac
done

# --- トークン必須チェック ---
if [ -z "$TOKEN" ]; then
  echo -e "${RED}エラー: --token が必要です${NC}"
  echo ""
  echo "使い方:"
  echo "  curl -fsSL https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.sh | bash -s -- --token YOUR_TOKEN"
  echo ""
  echo "トークンは WebUI のエージェント作成画面で取得できます。"
  exit 1
fi

# --- ヘッダー表示 ---
echo ""
echo -e "${BLUE}┌─────────────────────────────────────────────────┐${NC}"
echo -e "${BLUE}│  DevRelay Agent Installer                       │${NC}"
echo -e "${BLUE}└─────────────────────────────────────────────────┘${NC}"
echo ""

# =============================================================================
# Step 1: 依存ツール確認
# =============================================================================
echo -e "[1/6] 依存ツールを確認中..."

# Node.js チェック
if ! command -v node &> /dev/null; then
  echo -e "${RED}❌ Node.js が見つかりません${NC}"
  echo -e "   インストール: ${YELLOW}https://nodejs.org${NC}"
  echo -e "   または: ${YELLOW}curl -fsSL https://fnm.vercel.app/install | bash && fnm install 20${NC}"
  exit 1
fi

# Node.js バージョンチェック
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo -e "${RED}❌ Node.js 20 以上が必要です（現在: $(node -v)）${NC}"
  exit 1
fi
echo -e "  ✅ Node.js $(node -v)"

# git チェック
if ! command -v git &> /dev/null; then
  echo -e "${RED}❌ git が見つかりません${NC}"
  echo -e "   インストール: ${YELLOW}sudo apt install git${NC}"
  exit 1
fi
echo -e "  ✅ git $(git --version | cut -d' ' -f3)"

# npm チェック
if ! command -v npm &> /dev/null; then
  echo -e "${RED}❌ npm が見つかりません${NC}"
  exit 1
fi
echo -e "  ✅ npm $(npm -v)"

echo -e "${GREEN}✅ 依存ツール OK${NC}"
echo ""

# =============================================================================
# Step 2: リポジトリ取得
# =============================================================================
echo -e "[2/6] リポジトリを取得中..."

mkdir -p "$CONFIG_DIR"
mkdir -p "$CONFIG_DIR/logs"
mkdir -p "$CONFIG_DIR/bin"

if [ -d "$AGENT_DIR/.git" ]; then
  # 既存なら最新に更新
  echo "  既存のリポジトリを更新中..."
  cd "$AGENT_DIR"
  git pull --quiet 2>/dev/null || {
    echo -e "${YELLOW}  ⚠️ git pull に失敗。既存のコードで続行します${NC}"
  }
else
  # 新規 clone
  echo "  クローン中... (初回は時間がかかります)"
  git clone --quiet --depth 1 "$REPO_URL" "$AGENT_DIR"
fi

echo -e "${GREEN}✅ リポジトリ取得完了${NC}"
echo ""

# =============================================================================
# Step 3: ビルド
# =============================================================================
echo -e "[3/6] ビルド中..."

cd "$AGENT_DIR"

# pnpm が無ければインストール
if ! command -v pnpm &> /dev/null; then
  echo "  pnpm をインストール中..."
  npm install -g pnpm 2>/dev/null || {
    # npm グローバルに権限がない場合は corepack を試す
    if command -v corepack &> /dev/null; then
      corepack enable
      corepack prepare pnpm@latest --activate
    else
      echo -e "${RED}❌ pnpm のインストールに失敗しました${NC}"
      echo -e "   手動で: ${YELLOW}npm install -g pnpm${NC}"
      exit 1
    fi
  }
fi

# モノレポの依存関係をインストール・ビルド
echo "  依存関係をインストール中..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

echo "  shared パッケージをビルド中..."
pnpm --filter @devrelay/shared build

echo "  Agent をビルド中..."
pnpm --filter @devrelay/agent-linux build

echo -e "${GREEN}✅ ビルド完了${NC}"
echo ""

# =============================================================================
# Step 4: config.yaml 生成
# =============================================================================
echo -e "[4/6] 設定ファイルを生成中..."

MACHINE_NAME="$(hostname)/$(whoami)"

if [ -f "$CONFIG_FILE" ]; then
  echo -e "${YELLOW}  ⚠️ config.yaml が既に存在します。トークンのみ更新します${NC}"
  # 既存ファイルのトークンを更新（sed で置換）
  if grep -q "^token:" "$CONFIG_FILE"; then
    sed -i "s|^token:.*|token: \"$TOKEN\"|" "$CONFIG_FILE"
  else
    echo "token: \"$TOKEN\"" >> "$CONFIG_FILE"
  fi
else
  cat > "$CONFIG_FILE" << EOF
# DevRelay Agent 設定ファイル
# 詳細: https://github.com/murata1215/devrelay

machineName: "$MACHINE_NAME"
machineId: ""
serverUrl: "$SERVER_URL"
token: "$TOKEN"
projectsDirs:
  - $HOME
aiTools:
  default: claude
  claude:
    command: claude
  gemini:
    command: gemini
logLevel: info
EOF
  echo -e "  作成: $CONFIG_FILE"
fi

echo -e "  エージェント名: ${GREEN}$MACHINE_NAME${NC}"
echo -e "${GREEN}✅ 設定完了${NC}"
echo ""

# =============================================================================
# Step 5: devrelay-claude シンボリックリンク
# =============================================================================
echo -e "[5/6] シンボリックリンクを作成中..."

if command -v claude &> /dev/null; then
  CLAUDE_PATH=$(which claude)
  DEVRELAY_CLAUDE="$CONFIG_DIR/bin/devrelay-claude"
  ln -sf "$CLAUDE_PATH" "$DEVRELAY_CLAUDE" 2>/dev/null && {
    echo -e "  ✅ devrelay-claude -> $CLAUDE_PATH"
  } || {
    echo -e "${YELLOW}  ⚠️ シンボリックリンクの作成に失敗${NC}"
  }
else
  echo -e "  ⚪ Claude Code 未インストール（後からインストール可能）"
fi

echo ""

# =============================================================================
# Step 6: systemd ユーザーサービス登録・起動
# =============================================================================
echo -e "[6/6] systemd サービスを登録中..."

if command -v systemctl &> /dev/null; then
  SERVICE_DIR="$HOME/.config/systemd/user"
  SERVICE_FILE="$SERVICE_DIR/$SERVICE_NAME.service"
  NODE_PATH=$(which node)
  AGENT_ENTRY="$AGENT_DIR/agents/linux/dist/index.js"

  mkdir -p "$SERVICE_DIR"

  cat > "$SERVICE_FILE" << EOF
[Unit]
Description=DevRelay Agent ($MACHINE_NAME)
After=network.target

[Service]
Type=simple
WorkingDirectory=$AGENT_DIR/agents/linux
ExecStart=$NODE_PATH $AGENT_ENTRY
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF

  # サービス有効化・起動
  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE_NAME" 2>/dev/null
  systemctl --user restart "$SERVICE_NAME"

  # linger 有効化（ログアウト後もサービスを維持）
  loginctl enable-linger "$(whoami)" 2>/dev/null || true

  echo -e "  ✅ サービス登録・起動完了"
  echo -e "  ステータス確認: ${YELLOW}systemctl --user status $SERVICE_NAME${NC}"
  echo -e "  ログ確認: ${YELLOW}journalctl --user -u $SERVICE_NAME -f${NC}"
else
  echo -e "${YELLOW}  ⚠️ systemd が利用できません。手動で起動してください:${NC}"
  echo -e "     ${GREEN}cd $AGENT_DIR/agents/linux && node dist/index.js${NC}"
fi

echo ""

# =============================================================================
# 完了
# =============================================================================
echo -e "${GREEN}┌─────────────────────────────────────────────────┐${NC}"
echo -e "${GREEN}│  🎉 インストール完了！                            │${NC}"
echo -e "${GREEN}└─────────────────────────────────────────────────┘${NC}"
echo ""
echo -e "  エージェント名:  ${GREEN}$MACHINE_NAME${NC}"
echo -e "  設定:      ${GREEN}$CONFIG_FILE${NC}"
echo -e "  サービス:  ${GREEN}systemctl --user status $SERVICE_NAME${NC}"
echo ""
echo -e "管理コマンド:"
echo -e "  ${GREEN}systemctl --user restart $SERVICE_NAME${NC}  - 再起動"
echo -e "  ${GREEN}systemctl --user stop $SERVICE_NAME${NC}     - 停止"
echo -e "  ${GREEN}journalctl --user -u $SERVICE_NAME -f${NC}   - ログ"
echo ""
