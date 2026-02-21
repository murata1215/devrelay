#!/bin/bash

# =============================================================================
# DevRelay Agent ワンライナーインストーラー
# =============================================================================
#
# 使い方:
#   curl -fsSL https://raw.githubusercontent.com/murata1215/devrelay/main/scripts/install-agent.sh | bash -s -- --token YOUR_TOKEN
#
# プロキシ環境:
#   curl -fsSL ... | bash -s -- --token YOUR_TOKEN --proxy http://proxy:8080
#
# 前提条件:
#   - git
#   - curl, tar（ワンライナー実行時点で存在）
#   ※ Node.js 20+ と pnpm は未インストールなら自動でダウンロード・インストール
#
# 処理内容:
#   1. 依存ツールの確認（Node.js 20+, git, pnpm）
#   2. リポジトリを ~/.devrelay/agent/ に clone（既存なら git pull）
#   3. shared + agent をビルド
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
SERVER_URL="wss://devrelay.io/ws/agent"
PROXY_URL=""
FORCE=false

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
    --proxy)
      PROXY_URL="$2"
      shift 2
      ;;
    --force)
      FORCE=true
      shift 1
      ;;
    --help|-h)
      echo "Usage: $0 --token YOUR_TOKEN [--server SERVER_URL] [--proxy PROXY_URL] [--force]"
      echo ""
      echo "Options:"
      echo "  --token   (必須) WebUI で生成したエージェントトークン"
      echo "  --server  サーバーURL (デフォルト: wss://devrelay.io/ws/agent)"
      echo "  --proxy   プロキシURL (例: http://proxy:8080, socks5://proxy:1080)"
      echo "  --force   トークン検証をスキップ（意図的なトークン再利用時に使用）"
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

# --- 新形式トークン（drl_）からサーバーURL自動抽出 ---
# トークン形式: drl_<base64url エンコードされたサーバーURL>_<ランダム hex>
# --server が明示指定されていない場合のみ、トークンからURLを抽出する
if [[ "$TOKEN" == drl_* ]]; then
  # drl_ プレフィックスを除去し、最後の _<hex> 部分を除去して base64url 部分を取得
  TOKEN_BODY="${TOKEN#drl_}"
  B64_PART="${TOKEN_BODY%_*}"
  if [ -n "$B64_PART" ]; then
    # Base64URL → 標準 Base64 に変換（- → +, _ → /）してデコード
    DECODED_URL=$(echo "$B64_PART" | tr '_-' '/+' | base64 -d 2>/dev/null || true)
    if [ -n "$DECODED_URL" ]; then
      SERVER_URL="$DECODED_URL"
    fi
  fi
fi

# --- ヘッダー表示 ---
echo ""
echo -e "${BLUE}┌─────────────────────────────────────────────────┐${NC}"
echo -e "${BLUE}│  DevRelay Agent Installer                       │${NC}"
echo -e "${BLUE}└─────────────────────────────────────────────────┘${NC}"
echo ""

# =============================================================================
# Step 1: 依存ツール確認・自動インストール
# =============================================================================
# git のみハード依存。Node.js と pnpm は未インストールなら自動でインストールする。
echo -e "[1/6] 依存ツールを確認中..."

# --- git チェック（唯一の必須前提条件）---
if ! command -v git &> /dev/null; then
  echo -e "${RED}❌ git が必要です${NC}"
  echo -e "   インストール: ${YELLOW}sudo apt install git${NC}  または  ${YELLOW}sudo yum install git${NC}"
  echo ""
  echo -e "${RED}git をインストールしてから再実行してください。${NC}"
  exit 1
else
  echo -e "  ✅ git $(git --version | cut -d' ' -f3)"
fi

# --- Node.js チェック・自動インストール ---
# 未インストール or バージョン < 20 の場合、公式バイナリを ~/.devrelay/node/ にダウンロード
NEED_NODE_INSTALL=false

if ! command -v node &> /dev/null; then
  NEED_NODE_INSTALL=true
else
  EXISTING_NODE_MAJOR=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
  if [ "$EXISTING_NODE_MAJOR" -lt 20 ]; then
    echo -e "${YELLOW}  ⚠️ Node.js $(node -v) は古いバージョンです（20+ が必要）${NC}"
    NEED_NODE_INSTALL=true
  else
    echo -e "  ✅ Node.js $(node -v)"
  fi
fi

if [ "$NEED_NODE_INSTALL" = true ]; then
  echo -e "  📦 Node.js v20 をインストール中..."

  # アーキテクチャ検出
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64)  NODE_ARCH="x64" ;;
    aarch64) NODE_ARCH="arm64" ;;
    armv7l)  NODE_ARCH="armv7l" ;;
    *)
      echo -e "${RED}❌ 未対応アーキテクチャ: $ARCH${NC}"
      echo -e "   手動で Node.js 20+ をインストールしてください: ${YELLOW}https://nodejs.org${NC}"
      exit 1
      ;;
  esac

  # ~/.devrelay/ ディレクトリを事前に作成（CONFIG_DIR は後の Step でも使用）
  mkdir -p "$CONFIG_DIR"

  # Node.js 20 LTS バイナリをダウンロード・展開
  NODE_DL_VERSION="v20.20.0"
  NODE_DIR="$CONFIG_DIR/node"
  NODE_URL="https://nodejs.org/dist/${NODE_DL_VERSION}/node-${NODE_DL_VERSION}-linux-${NODE_ARCH}.tar.xz"

  mkdir -p "$NODE_DIR"
  echo -e "     ダウンロード: ${NODE_URL}"
  curl -fsSL "$NODE_URL" | tar -xJ -C "$NODE_DIR" --strip-components=1

  if [ -x "$NODE_DIR/bin/node" ]; then
    # PATH の先頭に追加（この後の pnpm install / ビルドでも使われる）
    export PATH="$NODE_DIR/bin:$PATH"
    echo -e "  ${GREEN}✅ Node.js $(node -v) をインストールしました ($NODE_DIR)${NC}"
  else
    echo -e "${RED}❌ Node.js のインストールに失敗しました${NC}"
    echo -e "   手動でインストールしてください: ${YELLOW}https://nodejs.org${NC}"
    exit 1
  fi
fi

# --- pnpm チェック・自動インストール ---
# npm は Node.js に同梱されているため、追加依存なし
if ! command -v pnpm &> /dev/null; then
  echo -e "  📦 pnpm をインストール中..."
  npm install -g pnpm 2>/dev/null
  if command -v pnpm &> /dev/null; then
    echo -e "  ${GREEN}✅ pnpm $(pnpm -v) をインストールしました${NC}"
  else
    echo -e "${RED}❌ pnpm のインストールに失敗しました${NC}"
    echo -e "   手動でインストールしてください: ${YELLOW}npm install -g pnpm${NC}"
    exit 1
  fi
else
  echo -e "  ✅ pnpm $(pnpm -v)"
fi

echo -e "${GREEN}✅ 依存ツール OK${NC}"
echo ""

# --- プロキシ設定プロンプト ---
# --proxy 引数が未指定の場合、対話的にプロキシ使用の有無を確認する
# curl | bash でも /dev/tty から読み取ることで対話入力が可能
if [ -z "$PROXY_URL" ]; then
  echo -n -e "🔌 プロキシを使用しますか？ (y/N): "
  read USE_PROXY < /dev/tty 2>/dev/null || USE_PROXY="n"
  if [[ "$USE_PROXY" =~ ^[Yy] ]]; then
    echo -n -e "   プロキシURL (例: http://proxy:8080): "
    read PROXY_URL < /dev/tty 2>/dev/null || PROXY_URL=""
    if [ -n "$PROXY_URL" ]; then
      echo -e "  ${GREEN}✅ プロキシ: $PROXY_URL${NC}"
    fi
  fi
  echo ""
fi

# プロキシが設定されている場合、git/pnpm/npm でもプロキシを使うよう環境変数をセット
if [ -n "$PROXY_URL" ]; then
  export HTTP_PROXY="$PROXY_URL"
  export HTTPS_PROXY="$PROXY_URL"
fi

# =============================================================================
# トークン事前検証
# =============================================================================
# サーバーに問い合わせて、トークンが別のマシンに割り当て済みでないか確認する
# 仮名（agent-*）でないマシン名が登録されていて、現在のマシンと異なる場合は中断
if [ "$FORCE" = false ]; then
  # WebSocket URL → HTTP URL に変換して API ベース URL を構築
  API_BASE_URL=$(echo "$SERVER_URL" | sed 's|^wss://|https://|; s|^ws://|http://|; s|/ws/agent$||')

  echo -e "🔍 トークンを検証中..."

  VALIDATE_RESPONSE=$(curl -s -f -X POST "${API_BASE_URL}/api/public/validate-token" \
    -H "Content-Type: application/json" \
    -d "{\"token\": \"$TOKEN\"}" 2>/dev/null) || {
    # curl 自体が失敗した場合（サーバーに到達不可など）はスキップして続行
    echo -e "${YELLOW}  ⚠️ トークン検証をスキップしました（サーバーに接続できません）${NC}"
    VALIDATE_RESPONSE=""
  }

  if [ -n "$VALIDATE_RESPONSE" ]; then
    # レスポンスを解析（jq が無い環境でも動作するよう grep + cut で処理）
    VALID=$(echo "$VALIDATE_RESPONSE" | grep -o '"valid":[a-z]*' | cut -d: -f2)
    PROVISIONAL=$(echo "$VALIDATE_RESPONSE" | grep -o '"provisional":[a-z]*' | cut -d: -f2)
    MACHINE_NAME_FROM_SERVER=$(echo "$VALIDATE_RESPONSE" | grep -o '"machineName":"[^"]*"' | cut -d'"' -f4)

    if [ "$VALID" = "false" ]; then
      echo -e "${RED}❌ エラー: 無効なトークンです${NC}"
      echo -e "   WebUI で正しいトークンを確認してください。"
      exit 1
    fi

    if [ "$VALID" = "true" ] && [ "$PROVISIONAL" = "false" ]; then
      # 仮名でないマシン名が登録されている場合、現在のマシンと比較
      CURRENT_MACHINE_NAME="$(hostname)/$(whoami)"
      if [ "$MACHINE_NAME_FROM_SERVER" != "$CURRENT_MACHINE_NAME" ]; then
        echo -e "${RED}❌ エラー: このトークンは別のエージェントに割り当て済みです${NC}"
        echo -e ""
        echo -e "   トークンのエージェント名:  ${YELLOW}$MACHINE_NAME_FROM_SERVER${NC}"
        echo -e "   このマシンの名前:          ${YELLOW}$CURRENT_MACHINE_NAME${NC}"
        echo -e ""
        echo -e "   WebUI で新しいエージェントを作成するか、"
        echo -e "   強制インストールする場合は ${GREEN}--force${NC} オプションを使用してください。"
        echo -e ""
        echo -e "   例: curl -fsSL ... | bash -s -- --token YOUR_TOKEN ${GREEN}--force${NC}"
        exit 1
      fi
    fi

    echo -e "${GREEN}  ✅ トークン検証OK${NC}"
  fi
fi
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

# モノレポの依存関係をインストール・ビルド
echo "  依存関係をインストール中..."
# --ignore-scripts: Electron 等の postinstall をスキップ（CLI Agent には不要）
# 企業ネットワークで Electron バイナリ取得が ECONNRESET で失敗する問題を回避
pnpm install --frozen-lockfile --ignore-scripts 2>/dev/null || pnpm install --ignore-scripts

echo "  shared パッケージをビルド中..."
pnpm --filter @devrelay/shared build

echo "  Agent をビルド中..."
pnpm --filter @devrelay/agent build

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

  # プロキシが指定されている場合、既存設定に追加/更新
  if [ -n "$PROXY_URL" ]; then
    if grep -q "^proxy:" "$CONFIG_FILE"; then
      # 既存の proxy.url を更新
      sed -i "/^proxy:/,/^[^ ]/{s|^  url:.*|  url: \"$PROXY_URL\"|}" "$CONFIG_FILE"
    else
      # proxy セクションを末尾に追加
      printf "\nproxy:\n  url: \"%s\"\n" "$PROXY_URL" >> "$CONFIG_FILE"
    fi
    echo -e "  プロキシ設定を更新しました"
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
  - /opt
aiTools:
  default: claude
  claude:
    command: claude
  gemini:
    command: gemini
logLevel: info
EOF

  # プロキシ設定がある場合は config.yaml に追記
  if [ -n "$PROXY_URL" ]; then
    printf "proxy:\n  url: \"%s\"\n" "$PROXY_URL" >> "$CONFIG_FILE"
  fi

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
# Step 6: Agent 起動・自動起動設定
# =============================================================================
echo -e "[6/6] Agent を起動中..."

# systemd ユーザーサービスが利用可能かチェック
# D-Bus セッションバスに接続できない環境（一部の SSH セッション、コンテナ等）では
# systemctl --user が使えないため、事前にテストする
SYSTEMD_USER_AVAILABLE=false
if command -v systemctl &> /dev/null; then
  if systemctl --user list-units &> /dev/null; then
    SYSTEMD_USER_AVAILABLE=true
  fi
fi

if [ "$SYSTEMD_USER_AVAILABLE" = true ]; then
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

  SYSTEMD_REGISTERED=true
  echo -e "  ✅ サービス登録・起動完了"
  echo -e "  ステータス確認: ${YELLOW}systemctl --user status $SERVICE_NAME${NC}"
  echo -e "  ログ確認: ${YELLOW}journalctl --user -u $SERVICE_NAME -f${NC}"
else
  SYSTEMD_REGISTERED=false
  NOHUP_STARTED=false
  echo -e "  ${GREEN}ℹ${NC} nohup + crontab で起動します"
  echo ""

  # node の絶対パスを取得（nohup・crontab で PATH に依存しないため）
  NODE_ABS_PATH=$(which node)

  # 既存の Agent プロセスを停止（再インストール対応）
  EXISTING_PID=$(pgrep -u "$(whoami)" -f "\.devrelay.*index\.js" 2>/dev/null)
  if [ -n "$EXISTING_PID" ]; then
    kill $EXISTING_PID 2>/dev/null || true
    echo -e "  ${YELLOW}既存の Agent プロセスを停止しました (PID: $EXISTING_PID)${NC}"
    sleep 2
  fi

  echo -e "  Agent をバックグラウンドで起動中..."
  cd "$AGENT_DIR/agents/linux"
  nohup "$NODE_ABS_PATH" "$AGENT_DIR/agents/linux/dist/index.js" < /dev/null > "$CONFIG_DIR/logs/agent.log" 2>&1 &
  AGENT_PID=$!
  sleep 3

  # プロセス生存確認
  if kill -0 $AGENT_PID 2>/dev/null; then
    NOHUP_STARTED=true
    echo -e "  ${GREEN}✅ Agent 起動成功 (PID: $AGENT_PID)${NC}"
    echo -e "  ログ: ${YELLOW}tail -f $CONFIG_DIR/logs/agent.log${NC}"

    # crontab @reboot で OS 再起動時の自動起動を設定
    CRONTAB_CMD="@reboot cd $AGENT_DIR/agents/linux && $NODE_ABS_PATH $AGENT_DIR/agents/linux/dist/index.js > $CONFIG_DIR/logs/agent.log 2>&1"
    # 既存の devrelay エントリを除去してから新しいエントリを追加（重複防止）
    ( crontab -l 2>/dev/null | grep -v "devrelay" ; echo "$CRONTAB_CMD" ) | crontab - 2>/dev/null && {
      CRONTAB_REGISTERED=true
      echo -e "  ${GREEN}✅ crontab @reboot 登録済み（OS 再起動時に自動起動）${NC}"
    } || {
      CRONTAB_REGISTERED=false
      echo -e "${YELLOW}  ⚠️ crontab の登録に失敗しました${NC}"
    }
  else
    echo -e "  ${RED}❌ Agent 起動に失敗しました${NC}"
    echo -e "  ログを確認: ${YELLOW}cat $CONFIG_DIR/logs/agent.log${NC}"
  fi
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
echo -e "  設定ファイル:    ${GREEN}$CONFIG_FILE${NC}"
echo -e "  サーバーURL:     ${GREEN}$SERVER_URL${NC}"
if [ -n "$PROXY_URL" ]; then
  echo -e "  プロキシ:        ${GREEN}$PROXY_URL${NC}"
fi
echo ""

if [ "$SYSTEMD_REGISTERED" = true ]; then
  echo -e "管理コマンド:"
  echo -e "  ${GREEN}systemctl --user restart $SERVICE_NAME${NC}  - 再起動"
  echo -e "  ${GREEN}systemctl --user stop $SERVICE_NAME${NC}     - 停止"
  echo -e "  ${GREEN}journalctl --user -u $SERVICE_NAME -f${NC}   - ログ"
elif [ "$NOHUP_STARTED" = true ]; then
  echo -e "  Agent は nohup で起動済みです (PID: $AGENT_PID)"
  if [ "$CRONTAB_REGISTERED" = true ]; then
    echo -e "  ${GREEN}✅ OS 再起動時も自動起動します（crontab @reboot）${NC}"
  fi
  echo ""
  echo -e "管理コマンド:"
  echo -e "  ログ確認:   ${GREEN}tail -f $CONFIG_DIR/logs/agent.log${NC}"
  echo -e "  停止:       ${GREEN}kill $AGENT_PID${NC}"
  echo -e "  再起動:     ${GREEN}nohup $NODE_ABS_PATH $AGENT_DIR/agents/linux/dist/index.js < /dev/null > $CONFIG_DIR/logs/agent.log 2>&1 &${NC}"
  echo -e "  crontab:    ${GREEN}crontab -l | grep devrelay${NC}"
else
  echo -e "手動起動:"
  echo -e "  ${GREEN}nohup $NODE_ABS_PATH $AGENT_DIR/agents/linux/dist/index.js < /dev/null > $CONFIG_DIR/logs/agent.log 2>&1 &${NC}"
fi
echo ""
