#!/bin/bash

# DevBridge Agent Installer for Linux
# Usage: curl -fsSL https://devbridge.io/install.sh | bash

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Config
DEVBRIDGE_VERSION="${DEVBRIDGE_VERSION:-latest}"
INSTALL_DIR="/opt/devbridge"
CONFIG_DIR="$HOME/.devbridge"
BIN_DIR="/usr/local/bin"

echo ""
echo -e "${BLUE}┌─────────────────────────────────────────────────┐${NC}"
echo -e "${BLUE}│  DevBridge Agent Installer                      │${NC}"
echo -e "${BLUE}└─────────────────────────────────────────────────┘${NC}"
echo ""

# Check if running as root
if [ "$EUID" -eq 0 ]; then 
  echo -e "${YELLOW}⚠️  Running as root. Agent will be installed for root user.${NC}"
fi

# Step 1: Check dependencies
echo -e "[1/5] Checking dependencies..."

check_command() {
  if ! command -v $1 &> /dev/null; then
    echo -e "${RED}❌ $1 not found${NC}"
    return 1
  else
    echo -e "  ✅ $1"
    return 0
  fi
}

DEPS_OK=true

# Check Node.js
if ! check_command node; then
  echo -e "${YELLOW}   Node.js is required. Install from: https://nodejs.org${NC}"
  DEPS_OK=false
else
  NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
  if [ "$NODE_VERSION" -lt 20 ]; then
    echo -e "${YELLOW}   ⚠️  Node.js 20+ recommended (found: $(node -v))${NC}"
  fi
fi

# Check npm
check_command npm || DEPS_OK=false

# Optional: Check AI tools
echo ""
echo "  Optional AI tools:"
check_command claude && echo -e "  ✅ Claude Code" || echo -e "  ⚪ Claude Code (not installed)"
check_command gemini && echo -e "  ✅ Gemini CLI" || echo -e "  ⚪ Gemini CLI (not installed)"
check_command aider && echo -e "  ✅ Aider" || echo -e "  ⚪ Aider (not installed)"
echo ""

if [ "$DEPS_OK" = false ]; then
  echo -e "${RED}❌ Missing required dependencies. Please install them first.${NC}"
  exit 1
fi

echo -e "${GREEN}✅ Dependencies OK${NC}"
echo ""

# Step 2: Download and install
echo -e "[2/5] Installing DevBridge Agent..."

# Create directories
sudo mkdir -p "$INSTALL_DIR"
mkdir -p "$CONFIG_DIR"
mkdir -p "$CONFIG_DIR/logs"

# Download (TODO: replace with actual download URL)
if [ "$DEVBRIDGE_VERSION" = "latest" ]; then
  DOWNLOAD_URL="https://github.com/devbridge/agent/releases/latest/download/devbridge-agent-linux.tar.gz"
else
  DOWNLOAD_URL="https://github.com/devbridge/agent/releases/download/v$DEVBRIDGE_VERSION/devbridge-agent-linux.tar.gz"
fi

# For now, install via npm (development)
echo "  Installing via npm..."
sudo npm install -g @devbridge/agent-linux 2>/dev/null || {
  echo -e "${YELLOW}  Using local development installation...${NC}"
  # Local dev: just copy files
  if [ -d "./agents/linux" ]; then
    sudo cp -r ./agents/linux/dist/* "$INSTALL_DIR/"
  fi
}

echo -e "${GREEN}✅ Installed to $INSTALL_DIR${NC}"
echo ""

# Step 3: Create symlink
echo -e "[3/5] Creating command link..."
sudo ln -sf "$INSTALL_DIR/cli/index.js" "$BIN_DIR/devbridge" 2>/dev/null || {
  # Alternative: add to PATH via wrapper script
  cat > /tmp/devbridge << 'EOF'
#!/bin/bash
node /opt/devbridge/cli/index.js "$@"
EOF
  sudo mv /tmp/devbridge "$BIN_DIR/devbridge"
  sudo chmod +x "$BIN_DIR/devbridge"
}
echo -e "${GREEN}✅ Command 'devbridge' available${NC}"
echo ""

# Step 4: Initial config
echo -e "[4/5] Initial setup..."

if [ ! -f "$CONFIG_DIR/config.yaml" ]; then
  HOSTNAME=$(hostname)
  cat > "$CONFIG_DIR/config.yaml" << EOF
# DevBridge Agent Configuration
machineName: $HOSTNAME
machineId: ""
serverUrl: wss://devbridge.io/ws/agent
token: ""
projectsDir: $HOME/projects
aiTools:
  default: claude
  claude:
    command: claude
  gemini:
    command: gemini
logLevel: info
EOF
  echo -e "  Created: $CONFIG_DIR/config.yaml"
fi

if [ ! -f "$CONFIG_DIR/projects.yaml" ]; then
  cat > "$CONFIG_DIR/projects.yaml" << EOF
# DevBridge Projects
# Add projects with: devbridge projects add /path/to/project
projects: []
EOF
  echo -e "  Created: $CONFIG_DIR/projects.yaml"
fi

echo -e "${GREEN}✅ Configuration ready${NC}"
echo ""

# Step 5: systemd service (optional)
echo -e "[5/5] Setting up systemd service..."

if command -v systemctl &> /dev/null; then
  SERVICE_FILE="/etc/systemd/system/devbridge.service"
  
  if [ ! -f "$SERVICE_FILE" ]; then
    sudo tee "$SERVICE_FILE" > /dev/null << EOF
[Unit]
Description=DevBridge Agent
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$HOME
ExecStart=/usr/local/bin/devbridge start
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
    
    sudo systemctl daemon-reload
    echo -e "  Created systemd service"
    echo -e "  ${YELLOW}Run 'sudo systemctl enable devbridge' to start on boot${NC}"
  else
    echo -e "  Systemd service already exists"
  fi
else
  echo -e "  ${YELLOW}systemd not available, skipping service setup${NC}"
fi

echo -e "${GREEN}✅ Service configured${NC}"
echo ""

# Done!
echo -e "${GREEN}┌─────────────────────────────────────────────────┐${NC}"
echo -e "${GREEN}│  🎉 Installation complete!                      │${NC}"
echo -e "${GREEN}└─────────────────────────────────────────────────┘${NC}"
echo ""
echo "Next steps:"
echo ""
echo -e "  ${BLUE}1.${NC} Get your token from: ${YELLOW}https://devbridge.io/dashboard${NC}"
echo ""
echo -e "  ${BLUE}2.${NC} Run setup:"
echo -e "     ${GREEN}devbridge setup${NC}"
echo ""
echo -e "  ${BLUE}3.${NC} Add projects:"
echo -e "     ${GREEN}devbridge projects add ~/my-project${NC}"
echo ""
echo -e "  ${BLUE}4.${NC} Start the agent:"
echo -e "     ${GREEN}devbridge start${NC}"
echo ""
echo "Commands:"
echo -e "  ${GREEN}devbridge status${NC}     - Check status"
echo -e "  ${GREEN}devbridge projects${NC}   - List projects"
echo -e "  ${GREEN}devbridge logs -f${NC}    - View logs"
echo -e "  ${GREEN}devbridge --help${NC}     - Show all commands"
echo ""
