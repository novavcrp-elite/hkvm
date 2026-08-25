#!/bin/bash
# HKVM Panel - Smart Installer
# If not installed: installs everything
# If installed: updates and restarts

INSTALL_DIR="/opt/hkvm"
DATA_DIR="$HOME/.hkvm"
VM_DIR="$HOME/vms"
PORT=8080
GITHUB="novavcrp-elite/hkvm"

R='\033[0;31m'; G='\033[0;32m'; Y='\033[1;33m'; B='\033[0;34m'
C='\033[0;36m'; W='\033[1;37m'; N='\033[0m'

ok()   { echo -e "  ${G}✓${N} $1"; }
info() { echo -e "  ${B}ℹ${N} $1"; }
warn() { echo -e "  ${Y}⚠${N} $1"; }
err()  { echo -e "  ${R}✗${N} $1"; }

# Root check
if [ "$EUID" -ne 0 ]; then err "Run as root (sudo)"; exit 1; fi

# Detect: installed or not?
IS_INSTALLED=false
[ -d "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/app.js" ] && IS_INSTALLED=true

if [ "$IS_INSTALLED" = false ]; then
    # ========== FRESH INSTALL ==========
    echo -e ""
    echo -e "  ${C}╔══════════════════════════════════════════════╗${N}"
    echo -e "  ${C}║     ${W}HKVM Panel - Installing...${C}              ║${N}"
    echo -e "  ${C}╚══════════════════════════════════════════════╝${N}"
    echo -e ""

    # Prerequisites
    info "Installing prerequisites..."
    if command -v apt-get &>/dev/null; then
        apt-get update -qq &>/dev/null
        apt-get install -y -qq curl wget git &>/dev/null
    elif command -v yum &>/dev/null; then
        yum install -y -q curl wget git &>/dev/null
    fi

    # Node.js
    if ! command -v node &>/dev/null; then
        info "Installing Node.js..."
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash - &>/dev/null
        apt-get install -y -qq nodejs &>/dev/null 2>&1 || yum install -y -q nodejs &>/dev/null
    fi
    command -v node &>/dev/null && ok "Node.js $(node -v)" || { err "Node.js failed"; exit 1; }

    # Download
    info "Downloading HKVM..."
    mkdir -p "$INSTALL_DIR"
    curl -sL -o /tmp/hkvm.tar.gz "https://github.com/${GITHUB}/archive/refs/heads/main.tar.gz"
    tar -xzf /tmp/hkvm.tar.gz -C /tmp/ 2>/dev/null
    EX=$(find /tmp -maxdepth 1 -name "*hkvm*" -type d | head -1)
    [ -n "$EX" ] && cp -r "$EX"/* "$INSTALL_DIR/" && rm -rf "$EX"
    rm -f /tmp/hkvm.tar.gz
    ok "Downloaded"

    # Dependencies
    info "Installing dependencies..."
    cd "$INSTALL_DIR" && npm install --production 2>/dev/null | tail -3
    ok "Dependencies ready"

    # Create directories
    mkdir -p "$DATA_DIR" "$VM_DIR/templates" "$VM_DIR/iso" "$VM_DIR/cloudvm"

    # Create .env
    SECRET=$(openssl rand -hex 32 2>/dev/null || echo "change-me")
    cat > "$INSTALL_DIR/.env" << ENVEOF
PORT=${PORT}
PANEL_NAME=HKVM Panel
PANEL_VERSION=V1.1
DEFAULT_LOGO_URL=https://i.imgur.com/0DmkSi4.png
HKVM_DATA_DIR=${DATA_DIR}
INTERNAL_API_SECRET=${SECRET}
ENVEOF
    ok "Config ready"

    # Systemd service
    cat > /etc/systemd/system/hkvm.service << SVCEOF
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
SVCEOF
    systemctl daemon-reload 2>/dev/null
    ok "Service created"

    # Management command
    echo '#!/bin/bash' > /usr/local/bin/hkvm
    echo 'bash /opt/hkvm/install.sh' >> /usr/local/bin/hkvm
    chmod +x /usr/local/bin/hkvm

    # Start
    info "Starting HKVM..."
    cd "$INSTALL_DIR" && nohup node app.js > /tmp/hkvm.log 2>&1 &
    sleep 3

    echo -e ""
    echo -e "  ${G}╔══════════════════════════════════════════════╗${N}"
    echo -e "  ${G}║       ✓ Installation Complete!               ║${N}"
    echo -e "  ${G}╚══════════════════════════════════════════════╝${N}"
    echo -e ""
    echo -e "  ${W}URL:${N}     http://localhost:${PORT}"
    echo -e "  ${W}Login:${N}   admin / admin"
    echo -e ""

else
    # ========== UPDATE ==========
    echo -e ""
    echo -e "  ${C}╔══════════════════════════════════════════════╗${N}"
    echo -e "  ${C}║     ${W}HKVM Panel - Updating...${C}                ║${N}"
    echo -e "  ${C}╚══════════════════════════════════════════════╝${N}"
    echo -e ""

    # Backup
    info "Backing up..."
    cp "$INSTALL_DIR/.env" /tmp/hkvm-env-backup 2>/dev/null
    ok "Backup saved"

    # Download latest
    info "Downloading latest version..."
    curl -sL -o /tmp/hkvm-update.tar.gz "https://github.com/${GITHUB}/archive/refs/heads/main.tar.gz"
    if [ -s /tmp/hkvm-update.tar.gz ]; then
        TMPDIR="/tmp/hkvm-update-$$"
        mkdir -p "$TMPDIR"
        tar -xzf /tmp/hkvm-update.tar.gz -C "$TMPDIR" 2>/dev/null
        EX=$(find "$TMPDIR" -maxdepth 1 -name "*hkvm*" -type d | head -1)

        if [ -n "$EX" ]; then
            # Update source files
            UPDATED=0
            for f in app.js lxc.js local-lxd.js nodes.js proxmox-api.js discord-bot.js discord-routes.js ip-allocation.js audit-log.js licenses.js tmate-routes.js novnc-routes.js package.json install.sh setup.sh .env.example package-lock.json; do
                [ -f "$EX/$f" ] && cp "$EX/$f" "$INSTALL_DIR/$f" 2>/dev/null && UPDATED=$((UPDATED+1))
            done

            # Update views (force overwrite all)
            [ -d "$EX/views" ] && cp -rf "$EX/views"/* "$INSTALL_DIR/views/" 2>/dev/null

            # Update public (including noVNC)
            [ -d "$EX/public" ] && cp -rf "$EX/public"/* "$INSTALL_DIR/public/" 2>/dev/null

            ok "Updated $UPDATED files"
        fi

        rm -rf "$TMPDIR" /tmp/hkvm-update.tar.gz
    else
        err "Download failed"; exit 1
    fi

    # Install new deps if needed
    if [ -f "$EX/package.json" ] && ! diff -q "$EX/package.json" "$INSTALL_DIR/package.json.bak" &>/dev/null; then
        info "Installing new dependencies..."
        cd "$INSTALL_DIR" && npm install --production 2>/dev/null | tail -3
    fi

    # Restore .env
    [ -f /tmp/hkvm-env-backup ] && cp /tmp/hkvm-env-backup "$INSTALL_DIR/.env" && rm -f /tmp/hkvm-env-backup
    ok "Configuration preserved"

    # Restart
    info "Restarting HKVM..."
    pkill -f "node.*app.js" 2>/dev/null
    sleep 2
    cd "$INSTALL_DIR" && nohup node app.js > /tmp/hkvm.log 2>&1 &
    sleep 3

    echo -e ""
    echo -e "  ${G}╔══════════════════════════════════════════════╗${N}"
    echo -e "  ${G}║       ✓ Update Complete!                     ║${N}"
    echo -e "  ${G}╚══════════════════════════════════════════════╝${N}"
    echo -e ""
    echo -e "  ${W}URL:${N} http://localhost:${PORT}"
    echo -e ""
fi
