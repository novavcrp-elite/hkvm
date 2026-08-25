#!/bin/bash
#=====================================================
#  HKVM Panel - One-Line Installer
#  Usage: curl -sL https://raw.githubusercontent.com/hopingboyz/hkvm/main/setup.sh | bash
#=====================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
GRAY='\033[0;90m'
NC='\033[0m'

# Config
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
GITHUB_REPO="novavcrp-elite/hkvm"
INSTALL_DIR="/opt/hkvm"
PORT=8080

echo -e ""
echo -e "  ${CYAN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "  ${CYAN}║       ${WHITE}HKVM Panel - Quick Installer${CYAN}                        ║${NC}"
echo -e "  ${CYAN}║       Advanced VM Management & Control Panel              ║${NC}"
echo -e "  ${CYAN}╚════════════════════════════════════════════════════════════╝${NC}"
echo -e ""

# Check root
if [ "$EUID" -ne 0 ]; then
    echo -e "  ${RED}✗ Please run as root (sudo)${NC}"
    exit 1
fi

echo -e "  ${BLUE}ℹ${NC} Starting installation..."
echo -e ""

# Install prerequisites
echo -e "  ${BLUE}ℹ${NC} Installing prerequisites..."

if command -v apt-get &>/dev/null; then
    apt-get update -qq &>/dev/null
    apt-get install -y -qq curl wget git tmate sshpass &>/dev/null
elif command -v yum &>/dev/null; then
    yum install -y -q curl wget git tmate sshpass &>/dev/null
elif command -v apk &>/dev/null; then
    apk add curl wget git tmate sshpass &>/dev/null
fi

# Install Node.js
if ! command -v node &>/dev/null; then
    echo -e "  ${BLUE}ℹ${NC} Installing Node.js..."
    if command -v snap &>/dev/null; then
        snap install node --classic &>/dev/null
    else
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash - &>/dev/null
        apt-get install -y -qq nodejs &>/dev/null 2>&1 || yum install -y -q nodejs &>/dev/null
    fi
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

# Try GitHub API with token first
TMP_FILE="/tmp/hkvm.tar.gz"

curl -sL \
    -H "Authorization: token ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github.v3+json" \
    -o "$TMP_FILE" \
    "https://api.github.com/repos/${GITHUB_REPO}/tarball/main" 2>/dev/null

# Fallback without token
if [ ! -s "$TMP_FILE" ] || ! tar -tzf "$TMP_FILE" &>/dev/null 2>&1; then
    curl -sL -o "$TMP_FILE" \
        "https://github.com/${GITHUB_REPO}/archive/refs/heads/main.tar.gz" 2>/dev/null
fi

if [ -s "$TMP_FILE" ] && tar -tzf "$TMP_FILE" &>/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} Download complete"

    # Extract
    tar -xzf "$TMP_FILE" -C /tmp/ 2>/dev/null
    EXTRACTED=$(find /tmp -maxdepth 1 -name "*hkvm*" -type d | head -1)

    if [ -n "$EXTRACTED" ]; then
        # Update self (setup.sh and install.sh)
        cp "$EXTRACTED/setup.sh" "$INSTALL_DIR/setup.sh" 2>/dev/null
        cp "$EXTRACTED/install.sh" "$INSTALL_DIR/install.sh" 2>/dev/null
        chmod +x "$INSTALL_DIR/setup.sh" "$INSTALL_DIR/install.sh" 2>/dev/null

        # Update all JS source files
        for f in app.js lxc.js local-lxd.js nodes.js proxmox-api.js discord-bot.js discord-routes.js ip-allocation.js audit-log.js licenses.js tmate-routes.js novnc-routes.js package.json package-lock.json .env.example .gitignore; do
            [ -f "$EXTRACTED/$f" ] && cp "$EXTRACTED/$f" "$INSTALL_DIR/$f" 2>/dev/null
        done

        # Update ALL views (force overwrite)
        [ -d "$EXTRACTED/views" ] && cp -rf "$EXTRACTED/views"/* "$INSTALL_DIR/views/" 2>/dev/null
        echo -e "  ${GREEN}✓${NC} Views updated"

        # Update ALL public files (including noVNC)
        [ -d "$EXTRACTED/public" ] && cp -rf "$EXTRACTED/public"/* "$INSTALL_DIR/public/" 2>/dev/null
        echo -e "  ${GREEN}✓${NC} Public files updated"

        # Verify new files exist
        MISSING=0
        for f in views/users/settings-discord.ejs views/users/settings-logs.ejs views/users/lxc-create.ejs views/partials/users/sidebar.ejs public/novnc/core/rfb.js; do
            if [ ! -f "$INSTALL_DIR/$f" ]; then
                echo -e "  ${YELLOW}⚠${NC} Missing: $f"
                MISSING=$((MISSING+1))
            fi
        done
        [ $MISSING -eq 0 ] && echo -e "  ${GREEN}✓${NC} All new files verified"

        rm -rf "$EXTRACTED"
    else
        tar -xzf "$TMP_FILE" -C "$INSTALL_DIR" --strip-components=1 2>/dev/null
    fi
    rm -f "$TMP_FILE"

    echo -e "  ${GREEN}✓${NC} Files extracted to $INSTALL_DIR"
else
    echo -e "  ${RED}✗${NC} Download failed. Check network connection."
    exit 1
fi

# Install dependencies
echo -e "  ${BLUE}ℹ${NC} Installing npm dependencies..."
cd "$INSTALL_DIR"
npm install --production 2>/dev/null | grep -v "^npm warn" | tail -3
echo -e "  ${GREEN}✓${NC} Dependencies installed"

# Create directories
echo -e "  ${BLUE}ℹ${NC} Setting up directories..."
mkdir -p "$HOME/.hkvm"
mkdir -p "$HOME/vms/templates"
mkdir -p "$HOME/vms/iso"
mkdir -p "$HOME/vms/cloudvm"

# Create .env
if [ ! -f "$INSTALL_DIR/.env" ]; then
    cat > "$INSTALL_DIR/.env" << EOF
PORT=${PORT}
PANEL_NAME=HKVM Panel
PANEL_VERSION=V1.1
DEFAULT_LOGO_URL=https://i.imgur.com/0DmkSi4.png
HKVM_DATA_DIR=$HOME/.hkvm
EOF
fi

# Create systemd service
cat > /etc/systemd/system/hkvm.service << EOF
[Unit]
Description=HKVM Panel - VM Management System
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
ExecStart=$(which node) ${INSTALL_DIR}/app.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=${PORT}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload 2>/dev/null
echo -e "  ${GREEN}✓${NC} Systemd service created"

# Make install script executable
chmod +x "$INSTALL_DIR/install.sh" 2>/dev/null
chmod +x "$INSTALL_DIR/setup.sh" 2>/dev/null

# Create /usr/local/bin/hkvm command
cat > /usr/local/bin/hkvm << 'CMDEOF'
#!/bin/bash
bash /opt/hkvm/install.sh
CMDEOF
chmod +x /usr/local/bin/hkvm

# Start HKVM
echo -e "  ${BLUE}ℹ${NC} Starting HKVM Panel..."
cd "$INSTALL_DIR"
nohup node app.js > /tmp/hkvm.log 2>&1 &
sleep 3

if pgrep -f "node.*app.js" &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} HKVM Panel started"
else
    echo -e "  ${YELLOW}⚠${NC} HKVM may need manual start: systemctl start hkvm"
fi

echo -e ""
echo -e "  ${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "  ${GREEN}║               ✓ Installation Complete!                    ║${NC}"
echo -e "  ${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo -e ""
echo -e "  ${WHITE}URL:${NC}         http://localhost:${PORT}"
echo -e "  ${WHITE}Login:${NC}       admin / admin"
echo -e "  ${WHITE}Install:${NC}     ${INSTALL_DIR}"
echo -e ""
echo -e "  ${GRAY}Manage with: ${NC}bash /opt/hkvm/install.sh"
echo -e "  ${GRAY}Or just run: ${NC}hkvm"
echo -e ""
