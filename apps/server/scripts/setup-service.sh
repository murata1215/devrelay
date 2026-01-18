#!/bin/bash

# DevRelay Server - Service Setup Script
# Usage: ./scripts/setup-service.sh

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo ""
echo -e "${BLUE}┌─────────────────────────────────────────────────┐${NC}"
echo -e "${BLUE}│  DevRelay Server - Service Setup               │${NC}"
echo -e "${BLUE}└─────────────────────────────────────────────────┘${NC}"
echo ""

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo -e "Server directory: ${YELLOW}$SERVER_DIR${NC}"
echo ""

# Check prerequisites
echo -e "[1/4] Checking prerequisites..."

# Check .env file
if [ ! -f "$SERVER_DIR/.env" ]; then
    echo -e "${RED}❌ .env file not found${NC}"
    echo -e "   Create one from .env.example:"
    echo -e "   ${YELLOW}cp $SERVER_DIR/.env.example $SERVER_DIR/.env${NC}"
    exit 1
fi
echo -e "  ✅ .env file exists"

# Check if built
if [ ! -f "$SERVER_DIR/dist/index.js" ]; then
    echo -e "${YELLOW}⚠️  dist/index.js not found. Building...${NC}"
    cd "$SERVER_DIR" && pnpm build
fi
echo -e "  ✅ Built"

# Check node path
NODE_PATH=$(which node)
echo -e "  ✅ Node: $NODE_PATH"
echo ""

# Create systemd service
echo -e "[2/4] Creating systemd user service..."

SERVICE_DIR="$HOME/.config/systemd/user"
mkdir -p "$SERVICE_DIR"

cat > "$SERVICE_DIR/devrelay-server.service" << EOF
[Unit]
Description=DevRelay Server
After=network.target

[Service]
Type=simple
WorkingDirectory=$SERVER_DIR
ExecStart=$NODE_PATH $SERVER_DIR/dist/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF

echo -e "  ✅ Created: $SERVICE_DIR/devrelay-server.service"
echo ""

# Enable service
echo -e "[3/4] Enabling service..."

systemctl --user daemon-reload
systemctl --user enable devrelay-server

# Enable lingering (run even when logged out)
loginctl enable-linger "$USER" 2>/dev/null || true

echo -e "  ✅ Service enabled"
echo ""

# Show status
echo -e "[4/4] Done!"
echo ""
echo -e "${GREEN}┌─────────────────────────────────────────────────┐${NC}"
echo -e "${GREEN}│  Setup complete!                                │${NC}"
echo -e "${GREEN}└─────────────────────────────────────────────────┘${NC}"
echo ""
echo -e "Commands:"
echo -e "  ${BLUE}Start:${NC}   systemctl --user start devrelay-server"
echo -e "  ${BLUE}Stop:${NC}    systemctl --user stop devrelay-server"
echo -e "  ${BLUE}Status:${NC}  systemctl --user status devrelay-server"
echo -e "  ${BLUE}Logs:${NC}    journalctl --user -u devrelay-server -f"
echo -e "  ${BLUE}Restart:${NC} systemctl --user restart devrelay-server"
echo ""
echo -e "Start now?"
read -p "(y/n): " START_NOW

if [ "$START_NOW" = "y" ] || [ "$START_NOW" = "Y" ]; then
    systemctl --user start devrelay-server
    echo ""
    systemctl --user status devrelay-server --no-pager
fi
