#!/bin/bash
#=====================================================
#  HKVM Panel - Interactive Installer
#  Advanced VM Management & Control Panel
#=====================================================

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
GRAY='\033[0;90m'
NC='\033[0m'
BOLD='\033[1m'

# Config
INSTALL_DIR="/opt/hkvm"
DATA_DIR="$HOME/.hkvm"
VM_DIR="$HOME/vms"
PORT=8080

#=====================================================
#  UTILITY FUNCTIONS
#=====================================================

get_user() { whoami 2>/dev/null || echo "root"; }
get_host() { hostname 2>/dev/null || echo "unknown"; }
get_time() { date "+%I:%M:%S %p" 2>/dev/null; }
is_running() { pgrep -f "node.*app.js" &>/dev/null; }

print_header() {
    clear
    echo -e ""
    echo -e "  ${GRAY}[$(get_time)]${NC}"
    echo -e "  ${WHITE}User: ${CYAN}$(get_user)${NC}   ${GRAY}|${NC}   ${WHITE}Host: ${CYAN}$(get_host)${NC}"
    echo -e "  ${GRAY}────────────────────────────────────────────────────────────${NC}"
}

print_services() {
    echo -e "  ${WHITE}SERVICES STATUS:${NC}"
    if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
        echo -e "  ${GRAY}├──${NC} Docker      ${GREEN}ON${NC}"
    else
        echo -e "  ${GRAY}├──${NC} Docker      ${RED}OFF${NC}"
    fi
    if is_running; then
        echo -e "  ${GRAY}└──${NC} HKVM        ${GREEN}ON${NC}  ➜ Port: ${PORT}"
    else
        echo -e "  ${GRAY}└──${NC} HKVM        ${RED}OFF${NC}  ➜ Port: ${PORT}"
    fi
    echo -e "  ${GRAY}────────────────────────────────────────────────────────────${NC}"
}

print_menu() {
    echo -e "  ${WHITE}HKVM INSTALLER OPTIONS:${NC}"
    echo -e "  ${GRAY}[1]${NC} Install HKVM"
    echo -e "  ${GRAY}[2]${NC} Turn ON HKVM"
    echo -e "  ${GRAY}[3]${NC} Turn OFF HKVM"
    echo -e "  ${GRAY}[4]${NC} Restart HKVM"
    echo -e "  ${GRAY}[5]${NC} Open HKVM Terminal"
    echo -e "  ${GRAY}[6]${NC} Download OS Template"
    echo -e "  ${GRAY}[7]${NC} Uninstall HKVM"
    echo -e "  ${GRAY}[8]${NC} Configure Environment"
    echo -e "  ${GRAY}[0]${NC} Exit"
    echo -e ""
    echo -ne "  ${PURPLE}«Select:»${NC} "
}

ok() { echo -e "  ${GREEN}✓${NC} $1"; }
info() { echo -e "  ${BLUE}ℹ${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
err() { echo -e "  ${RED}✗${NC} $1"; }

#=====================================================
#  ENVIRONMENT CONFIGURATION
#=====================================================

configure_env() {
    echo -e ""
    echo -e "  ${WHITE}═══ Environment Configuration ═══${NC}"
    echo -e ""
    echo -e "  ${GRAY}[1]${NC} Set Port (current: ${PORT})"
    echo -e "  ${GRAY}[2]${NC} Set Panel Name"
    echo -e "  ${GRAY}[3]${NC} Set Panel Logo URL"
    echo -e "  ${GRAY}[4]${NC} Set Discord Bot Token"
    echo -e "  ${GRAY}[5]${NC} Set Discord Admin IDs"
    echo -e "  ${GRAY}[6]${NC} Set Internal API Secret"
    echo -e "  ${GRAY}[7]${NC} Set Data Directory"
    echo -e "  ${GRAY}[8]${NC} Show Current Config"
    echo -e "  ${GRAY}[9]${NC} Reset to Defaults"
    echo -e "  ${GRAY}[0]${NC} Back"
    echo -e ""
    echo -ne "  ${PURPLE}«Select:»${NC} "
    read -r choice

    mkdir -p "$INSTALL_DIR" 2>/dev/null

    case $choice in
        1)
            echo -ne "  Enter port [${PORT}]: "
            read -r new_port
            if [ -n "$new_port" ]; then
                sed -i "s/^PORT=.*/PORT=$new_port/" "$INSTALL_DIR/.env" 2>/dev/null
                if ! grep -q "^PORT=" "$INSTALL_DIR/.env" 2>/dev/null; then
                    echo "PORT=$new_port" >> "$INSTALL_DIR/.env"
                fi
                PORT=$new_port
                ok "Port set to $new_port"
            fi
            ;;
        2)
            echo -ne "  Enter panel name [HKVM Panel]: "
            read -r val
            val=${val:-"HKVM Panel"}
            sed -i "s/^PANEL_NAME=.*/PANEL_NAME=$val/" "$INSTALL_DIR/.env" 2>/dev/null
            if ! grep -q "^PANEL_NAME=" "$INSTALL_DIR/.env" 2>/dev/null; then
                echo "PANEL_NAME=$val" >> "$INSTALL_DIR/.env"
            fi
            ok "Panel name set to $val"
            ;;
        3)
            echo -ne "  Enter logo URL [https://i.imgur.com/0DmkSi4.png]: "
            read -r val
            val=${val:-"https://i.imgur.com/0DmkSi4.png"}
            sed -i "s|^DEFAULT_LOGO_URL=.*|DEFAULT_LOGO_URL=$val|" "$INSTALL_DIR/.env" 2>/dev/null
            if ! grep -q "^DEFAULT_LOGO_URL=" "$INSTALL_DIR/.env" 2>/dev/null; then
                echo "DEFAULT_LOGO_URL=$val" >> "$INSTALL_DIR/.env"
            fi
            ok "Logo URL set"
            ;;
        4)
            echo -ne "  Enter Discord Bot Token: "
            read -r val
            if [ -n "$val" ]; then
                sed -i "s/^DISCORD_BOT_TOKEN=.*/DISCORD_BOT_TOKEN=$val/" "$INSTALL_DIR/.env" 2>/dev/null
                if ! grep -q "^DISCORD_BOT_TOKEN=" "$INSTALL_DIR/.env" 2>/dev/null; then
                    echo "DISCORD_BOT_TOKEN=$val" >> "$INSTALL_DIR/.env"
                fi
                ok "Discord token set"
            fi
            ;;
        5)
            echo -ne "  Enter Discord Admin IDs (comma-separated): "
            read -r val
            if [ -n "$val" ]; then
                sed -i "s/^DISCORD_ADMIN_IDS=.*/DISCORD_ADMIN_IDS=$val/" "$INSTALL_DIR/.env" 2>/dev/null
                if ! grep -q "^DISCORD_ADMIN_IDS=" "$INSTALL_DIR/.env" 2>/dev/null; then
                    echo "DISCORD_ADMIN_IDS=$val" >> "$INSTALL_DIR/.env"
                fi
                ok "Discord admin IDs set"
            fi
            ;;
        6)
            echo -ne "  Enter Internal API Secret: "
            read -r val
            if [ -z "$val" ]; then
                val=$(openssl rand -hex 32 2>/dev/null || echo "change-me-in-production")
                info "Generated secret: ${val:0:8}..."
            fi
            sed -i "s/^INTERNAL_API_SECRET=.*/INTERNAL_API_SECRET=$val/" "$INSTALL_DIR/.env" 2>/dev/null
            if ! grep -q "^INTERNAL_API_SECRET=" "$INSTALL_DIR/.env" 2>/dev/null; then
                echo "INTERNAL_API_SECRET=$val" >> "$INSTALL_DIR/.env"
            fi
            ok "API secret set"
            ;;
        7)
            echo -ne "  Enter data directory [${DATA_DIR}]: "
            read -r val
            val=${val:-"$DATA_DIR"}
            mkdir -p "$val"
            sed -i "s|^HKVM_DATA_DIR=.*|HKVM_DATA_DIR=$val|" "$INSTALL_DIR/.env" 2>/dev/null
            if ! grep -q "^HKVM_DATA_DIR=" "$INSTALL_DIR/.env" 2>/dev/null; then
                echo "HKVM_DATA_DIR=$val" >> "$INSTALL_DIR/.env"
            fi
            DATA_DIR=$val
            ok "Data directory set to $val"
            ;;
        8)
            echo -e ""
            echo -e "  ${WHITE}Current Configuration:${NC}"
            echo -e "  ${GRAY}────────────────────────────────────────${NC}"
            if [ -f "$INSTALL_DIR/.env" ]; then
                grep -v "^#" "$INSTALL_DIR/.env" 2>/dev/null | while IFS='=' read -r key val; do
                    # Mask sensitive values
                    if [[ "$key" == *"TOKEN"* || "$key" == *"SECRET"* ]]; then
                        val="${val:0:8}...[masked]"
                    fi
                    echo -e "  ${CYAN}$key${NC} = $val"
                done
            else
                warn "No .env file found"
            fi
            echo -e "  ${GRAY}────────────────────────────────────────${NC}"
            ;;
        9)
            rm -f "$INSTALL_DIR/.env"
            create_default_env
            ok "Reset to defaults"
            ;;
        0) return ;;
    esac
}

create_default_env() {
    mkdir -p "$INSTALL_DIR" 2>/dev/null
    local secret=$(openssl rand -hex 32 2>/dev/null || echo "change-me-in-production")
    cat > "$INSTALL_DIR/.env" << EOF
# HKVM Panel Configuration
PORT=${PORT}
PANEL_NAME=HKVM Panel
PANEL_VERSION=V1.0
DEFAULT_LOGO_URL=https://i.imgur.com/0DmkSi4.png
HKVM_DATA_DIR=${DATA_DIR}
# DISCORD_BOT_TOKEN=
# DISCORD_ADMIN_IDS=
INTERNAL_API_SECRET=${secret}
EOF
}

#=====================================================
#  INSTALLATION
#=====================================================

install_hkvm() {
    echo -e ""
    echo -e "  ${CYAN}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "  ${CYAN}║          ${WHITE}HKVM Panel - Installation${CYAN}                         ║${NC}"
    echo -e "  ${CYAN}╚════════════════════════════════════════════════════════════╝${NC}"

    if [ -d "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/app.js" ]; then
        warn "HKVM already installed at $INSTALL_DIR"
        echo -ne "  Reinstall? [y/N]: "
        read -r ans
        [[ ! "$ans" =~ ^[Yy]$ ]] && return 0
    fi

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
        if command -v snap &>/dev/null; then
            snap install node --classic &>/dev/null
        else
            curl -fsSL https://deb.nodesource.com/setup_20.x | bash - &>/dev/null
            apt-get install -y -qq nodejs &>/dev/null 2>&1 || yum install -y -q nodejs &>/dev/null
        fi
    fi

    command -v node &>/dev/null && ok "Node.js $(node -v) ready" || { err "Node.js install failed"; return 1; }

    # Download
    info "Downloading HKVM..."
    mkdir -p "$INSTALL_DIR"
    local tmp="/tmp/hkvm.tar.gz"
    curl -sL -o "$tmp" "https://github.com/novavcrp-elite/hkvm/archive/refs/heads/main.tar.gz" 2>/dev/null

    if [ -s "$tmp" ] && tar -tzf "$tmp" &>/dev/null 2>&1; then
        tar -xzf "$tmp" -C /tmp/ 2>/dev/null
        local dir=$(find /tmp -maxdepth 1 -name "*hkvm*" -type d | head -1)
        [ -n "$dir" ] && cp -r "$dir"/* "$INSTALL_DIR/" 2>/dev/null && rm -rf "$dir"
        rm -f "$tmp"
        ok "Download complete"
    else
        err "Download failed"; return 1
    fi

    # Install deps
    info "Installing dependencies..."
    cd "$INSTALL_DIR"
    npm install --production 2>/dev/null | tail -3
    ok "Dependencies installed"

    # Create dirs
    mkdir -p "$DATA_DIR" "$VM_DIR/templates" "$VM_DIR/iso" "$VM_DIR/cloudvm"

    # Env file
    [ ! -f "$INSTALL_DIR/.env" ] && create_default_env
    ok "Configuration ready"

    # Systemd
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
    ok "Systemd service created"

    # Management command
    cat > /usr/local/bin/hkvm << 'EOF'
#!/bin/bash
bash /opt/hkvm/install.sh
EOF
    chmod +x /usr/local/bin/hkvm

    # Start
    info "Starting HKVM..."
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
    echo -e "  ${WHITE}Config:${NC}  /opt/hkvm/.env"
    echo -e ""
}

#=====================================================
#  SERVICE CONTROL
#=====================================================

turn_on() {
    echo -e ""
    if is_running; then warn "Already running"; return 0; fi
    info "Starting HKVM..."
    if [ -d "$INSTALL_DIR" ]; then
        cd "$INSTALL_DIR"
        systemctl start hkvm 2>/dev/null || nohup node app.js > /tmp/hkvm.log 2>&1 &
        sleep 3
        is_running && ok "HKVM started" || err "Failed to start"
    else
        err "Not installed"
    fi
}

turn_off() {
    echo -e ""
    if ! is_running; then warn "Not running"; return 0; fi
    info "Stopping HKVM..."
    systemctl stop hkvm 2>/dev/null
    pkill -f "node.*app.js" 2>/dev/null
    sleep 1
    is_running && { pkill -9 -f "node.*app.js" 2>/dev/null; sleep 1; }
    ! is_running && ok "HKVM stopped" || err "Failed to stop"
}

restart_hkvm() {
    echo -e ""
    info "Restarting HKVM..."
    turn_off 2>/dev/null
    sleep 2
    turn_on
}

open_terminal() {
    echo -e ""
    if ! is_running; then err "Not running"; return 1; fi
    echo -e "  ${WHITE}URL:${NC}   http://localhost:${PORT}"
    echo -e "  ${WHITE}Login:${NC} admin / admin"
    command -v xdg-open &>/dev/null && xdg-open "http://localhost:${PORT}" 2>/dev/null &
}

download_template() {
    echo -e ""
    echo -e "  ${WHITE}OS Templates:${NC}"
    echo -e "  ${GRAY}[1]${NC} Ubuntu 22.04  ${GRAY}[2]${NC} Ubuntu 24.04  ${GRAY}[3]${NC} Debian 12"
    echo -e "  ${GRAY}[4]${NC} Fedora 40    ${GRAY}[5]${NC} CentOS 9     ${GRAY}[6]${NC} AlmaLinux 9"
    echo -ne "  ${PURPLE}«Select:»${NC} "
    read -r t
    mkdir -p "$VM_DIR/templates"
    case $t in
        1) curl -L -o "$VM_DIR/templates/ubuntu-22.04.qcow2" "https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img" 2>/dev/null && ok "Ubuntu 22.04 downloaded" ;;
        2) curl -L -o "$VM_DIR/templates/ubuntu-24.04.qcow2" "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img" 2>/dev/null && ok "Ubuntu 24.04 downloaded" ;;
        3) curl -L -o "$VM_DIR/templates/debian-12.qcow2" "https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-generic-amd64.qcow2" 2>/dev/null && ok "Debian 12 downloaded" ;;
        4) curl -L -o "$VM_DIR/templates/fedora-40.qcow2" "https://download.fedoraproject.org/pub/fedora/linux/releases/40/Cloud/x86_64/images/Fedora-Cloud-Base-40-1.14.x86_64.qcow2" 2>/dev/null && ok "Fedora 40 downloaded" ;;
        5) curl -L -o "$VM_DIR/templates/centos-9.qcow2" "https://cloud.centos.org/centos/9-stream/x86_64/images/CentOS-Stream-GenericCloud-9-latest.x86_64.qcow2" 2>/dev/null && ok "CentOS 9 downloaded" ;;
        6) curl -L -o "$VM_DIR/templates/almalinux-9.qcow2" "https://repo.almalinux.org/almalinux/9/cloud/x86_64/images/AlmaLinux-9-GenericCloud-latest.x86_64.qcow2" 2>/dev/null && ok "AlmaLinux 9 downloaded" ;;
    esac
}

uninstall_hkvm() {
    echo -e ""
    echo -e "  ${RED}⚠ Uninstall HKVM Panel${NC}"
    echo -e "  ${GRAY}Data directory ($DATA_DIR) will be preserved.${NC}"
    echo -ne "  Continue? [y/N]: "
    read -r ans
    [[ ! "$ans" =~ ^[Yy]$ ]] && return 0

    turn_off 2>/dev/null
    systemctl disable hkvm 2>/dev/null
    rm -f /etc/systemd/system/hkvm.service
    systemctl daemon-reload 2>/dev/null
    rm -rf "$INSTALL_DIR"
    rm -f /usr/local/bin/hkvm
    ok "Uninstalled (data preserved)"
}

#=====================================================
#  AUTO MODE (for piping)
#=====================================================

auto_install() {
    info "Auto-install mode..."
    install_hkvm
}

#=====================================================
#  MAIN
#=====================================================

# Check if running in auto mode (piped)
if [ -t 0 ]; then
    # Interactive mode
    while true; do
        print_header
        print_services
        print_menu
        read -r choice

        case $choice in
            1) install_hkvm ;;
            2) turn_on ;;
            3) turn_off ;;
            4) restart_hkvm ;;
            5) open_terminal ;;
            6) download_template ;;
            7) uninstall_hkvm ;;
            8) configure_env ;;
            0) echo -e "  ${GREEN}Goodbye!${NC} 👋"; echo -e ""; exit 0 ;;
            *) echo -e ""; err "Invalid selection" ;;
        esac

        echo -e ""
        echo -ne "  Press Enter to continue..."
        read -r
    done
else
    # Auto mode (piped to bash)
    auto_install
fi
