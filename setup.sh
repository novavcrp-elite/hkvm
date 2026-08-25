#!/bin/bash
#=====================================================
#  HKVM Panel - One-Line Installer
#  Usage: curl -sL https://raw.githubusercontent.com/novavcrp-elite/hkvm/main/setup.sh | bash
#=====================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
NC='\033[0m'

# Config
GITHUB_REPO="novavcrp-elite/hkvm"
INSTALL_DIR="/opt/hkvm"
PORT=8080

echo -e ""
echo -e "  ${CYAN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "  ${CYAN}║       ${WHITE}HKVM Panel - Quick Installer${CYAN}                        ║${NC}"
echo -e "  ${CYAN}╚════════════════════════════════════════════════════════════╝${NC}"
echo -e ""

if [ "$EUID" -ne 0 ]; then
    echo -e "  ${RED}✗ Please run as root (sudo)${NC}"
    exit 1
fi

echo -e "  ${BLUE}ℹ${NC} Installing prerequisites..."

if command -v apt-get &>/dev/null; then
    apt-get update -qq &>/dev/null
    apt-get install -y -qq curl wget git &>/dev/null
elif command -v yum &>/dev/null; then
    yum install -y -q curl wget git &>/dev/null
fi

# Install Node.js
if ! command -v node &>/dev/null; then
    echo -e "  ${BLUE}ℹ${NC} Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - &>/dev/null
    apt-get install -y -qq nodejs &>/dev/null 2>&1 || yum install -y -q nodejs &>/dev/null
fi

if command -v node &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Node.js $(node -v) installed"
else
    echo -e "  ${RED}✗${NC} Failed to install Node.js"
    exit 1
fi

# Download HKVM
echo -e "  ${BLUE}ℹ${NC} Downloading HKVM Panel..."
mkdir -p "$INSTALL_DIR"

TMP_FILE="/tmp/hkvm.tar.gz"
curl -sL -o "$TMP_FILE" "https://github.com/${GITHUB_REPO}/archive/refs/heads/main.tar.gz" 2>/dev/null

if [ -s "$TMP_FILE" ] && tar -tzf "$TMP_FILE" &>/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} Download complete"
    tar -xzf "$TMP_FILE" -C /tmp/ 2>/dev/null
    EXTRACTED=$(find /tmp -maxdepth 1 -name "*hkvm*" -type d | head -1)
    if [ -n "$EXTRACTED" ]; then
        cp -r "$EXTRACTED"/* "$INSTALL_DIR/" 2>/dev/null
        rm -rf "$EXTRACTED"
    fi
    rm -f "$TMP_FILE"
    echo -e "  ${GREEN}✓${NC} Files extracted"
else
    echo -e "  ${RED}✗${NC} Download failed"
    exit 1
fi

# Install dependencies
echo -e "  ${BLUE}ℹ${NC} Installing dependencies..."
cd "$INSTALL_DIR"
npm install --production 2>/dev/null | tail -3
echo -e "  ${GREEN}✓${NC} Dependencies installed"

# Create directories
mkdir -p "$HOME/.hkvm" "$HOME/vms/templates" "$HOME/vms/iso" "$HOME/vms/cloudvm"

# Create .env
if [ ! -f "$INSTALL_DIR/.env" ]; then
    cat > "$INSTALL_DIR/.env" << EOF
PORT=${PORT}
PANEL_NAME=HKVM Panel
PANEL_VERSION=V1.0
DEFAULT_LOGO_URL=https://i.imgur.com/0DmkSi4.png
HKVM_DATA_DIR=$HOME/.hkvm
EOF
fi

# Create systemd service
cat > /etc/systemd/system/hkvm.service << EOF
[Unit]
Description=HKVM Panel
After=network.target
[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
ExecStart=$(which node) ${INSTALL_DIR}/app.js
Restart=on-failure
RestartSec=5
Environment=PORT=${PORT}
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload 2>/dev/null
chmod +x "$INSTALL_DIR/install.sh" 2>/dev/null

# Create /usr/local/bin/hkvm command
cat > /usr/local/bin/hkvm << 'EOF2'
#!/bin/bash
bash /opt/hkvm/install.sh
EOF2
chmod +x /usr/local/bin/hkvm

# Start
echo -e "  ${BLUE}ℹ${NC} Starting HKVM Panel..."
cd "$INSTALL_DIR"
nohup node app.js > /tmp/hkvm.log 2>&1 &
sleep 3

echo -e ""
echo -e "  ${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "  ${GREEN}║               ✓ Installation Complete!                    ║${NC}"
echo -e "  ${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo -e ""
echo -e "  ${WHITE}URL:${NC}     http://localhost:${PORT}"
echo -e "  ${WHITE}Login:${NC}   admin / admin"
echo -e "  ${WHITE}Manage:${NC}  bash /opt/hkvm/install.sh"
echo -e ""
