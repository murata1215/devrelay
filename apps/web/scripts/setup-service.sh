#!/bin/bash

# DevRelay WebUI - Service Setup Script
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
echo -e "${BLUE}│  DevRelay WebUI - Service Setup                │${NC}"
echo -e "${BLUE}└─────────────────────────────────────────────────┘${NC}"
echo ""

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo -e "WebUI directory: ${YELLOW}$WEB_DIR${NC}"
echo ""

# Check prerequisites
echo -e "[1/4] Checking prerequisites..."

# Check node_modules
if [ ! -d "$WEB_DIR/node_modules" ]; then
    echo -e "${YELLOW}⚠️  node_modules not found. Installing dependencies...${NC}"
    cd "$WEB_DIR" && pnpm install
fi
echo -e "  ✅ Dependencies installed"

# Check node and pnpm paths
NODE_PATH=$(which node)
PNPM_PATH=$(which pnpm)
echo -e "  ✅ Node: $NODE_PATH"
echo -e "  ✅ pnpm: $PNPM_PATH"
echo ""

# Create systemd service
echo -e "[2/4] Creating systemd user service..."

SERVICE_DIR="$HOME/.config/systemd/user"
mkdir -p "$SERVICE_DIR"

cat > "$SERVICE_DIR/devrelay-web.service" << EOF
[Unit]
Description=DevRelay WebUI (Vite Dev Server)
After=network.target devrelay-server.service

[Service]
Type=simple
WorkingDirectory=$WEB_DIR
ExecStart=$PNPM_PATH dev
Restart=always
RestartSec=10
Environment=NODE_ENV=development

[Install]
WantedBy=default.target
EOF

echo -e "  ✅ Created: $SERVICE_DIR/devrelay-web.service"
echo ""

# Enable service
echo -e "[3/4] Enabling service..."

systemctl --user daemon-reload
systemctl --user enable devrelay-web

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
echo -e "${YELLOW}Note:${NC} This runs Vite dev server (with HMR)."
echo -e "      For production, use Caddy + static files (pnpm build)."
echo ""
echo -e "Commands:"
echo -e "  ${BLUE}Start:${NC}   systemctl --user start devrelay-web"
echo -e "  ${BLUE}Stop:${NC}    systemctl --user stop devrelay-web"
echo -e "  ${BLUE}Status:${NC}  systemctl --user status devrelay-web"
echo -e "  ${BLUE}Logs:${NC}    journalctl --user -u devrelay-web -f"
echo -e "  ${BLUE}Restart:${NC} systemctl --user restart devrelay-web"
echo ""
echo -e "Start now?"
read -p "(y/n): " START_NOW

if [ "$START_NOW" = "y" ] || [ "$START_NOW" = "Y" ]; then
    systemctl --user start devrelay-web
    echo ""
    systemctl --user status devrelay-web --no-pager
fi
