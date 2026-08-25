#!/bin/bash
#=====================================================
#  HKVM Panel - Interactive Installer
#=====================================================

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; PURPLE='\033[0;35m'; CYAN='\033[0;36m'
WHITE='\033[1;37m'; GRAY='\033[0;90m'; NC='\033[0m'

INSTALL_DIR="/opt/hkvm"
DATA_DIR="$HOME/.hkvm"
VM_DIR="$HOME/vms"
PORT=8080

clear; echo ""

get_user() { whoami 2>/dev/null || echo "root"; }
get_host() { hostname 2>/dev/null || echo "unknown"; }
get_time() { date "+%I:%M:%S %p" 2>/dev/null; }

is_running() { pgrep -f "node.*app.js" &>/dev/null; }

echo -e "  ${GRAY}[$(get_time)]${NC}"
echo -e "  ${WHITE}User: ${CYAN}$(get_user)${NC}   ${GRAY}|${NC}   ${WHITE}Host: ${CYAN}$(get_host)${NC}"
echo -e "  ${GRAY}────────────────────────────────────────────────────────────${NC}"
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
echo -e ""
echo -e "  ${WHITE}HKVM INSTALLER OPTIONS:${NC}"
echo -e "  ${GRAY}[1]${NC} Install HKVM"
echo -e "  ${GRAY}[2]${NC} Turn ON HKVM"
echo -e "  ${GRAY}[3]${NC} Turn OFF HKVM"
echo -e "  ${GRAY}[4]${NC} Restart HKVM"
echo -e "  ${GRAY}[5]${NC} Open HKVM Terminal"
echo -e "  ${GRAY}[6]${NC} Download OS Template"
echo -e "  ${GRAY}[7]${NC} Uninstall HKVM"
echo -e "  ${GRAY}[0]${NC} Exit"
echo -e ""
echo -ne "  ${PURPLE}«Select:»${NC} "
read -r choice

case $choice in
    1)
        echo -e ""
        echo -e "  ${BLUE}ℹ${NC} Installing prerequisites..."
        if command -v apt-get &>/dev/null; then
            apt-get update -qq &>/dev/null
            apt-get install -y -qq nodejs npm git &>/dev/null
        elif command -v yum &>/dev/null; then
            yum install -y -q nodejs npm git &>/dev/null
        fi
        if ! command -v node &>/dev/null; then
            curl -fsSL https://deb.nodesource.com/setup_20.x | bash - &>/dev/null
            apt-get install -y -qq nodejs &>/dev/null 2>&1
        fi
        echo -e "  ${GREEN}✓${NC} Prerequisites installed"
        
        echo -e "  ${BLUE}ℹ${NC} Downloading HKVM..."
        mkdir -p "$INSTALL_DIR"
        curl -sL -o /tmp/hkvm.tar.gz "https://github.com/novavcrp-elite/hkvm/archive/refs/heads/main.tar.gz"
        tar -xzf /tmp/hkvm.tar.gz -C /tmp/ 2>/dev/null
        EXTRACTED=$(find /tmp -maxdepth 1 -name "*hkvm*" -type d | head -1)
        [ -n "$EXTRACTED" ] && cp -r "$EXTRACTED"/* "$INSTALL_DIR/" 2>/dev/null && rm -rf "$EXTRACTED"
        rm -f /tmp/hkvm.tar.gz
        
        cd "$INSTALL_DIR"
        npm install --production 2>/dev/null | tail -3
        mkdir -p "$HOME/.hkvm" "$HOME/vms/templates" "$HOME/vms/iso" "$HOME/vms/cloudvm"
        
        [ ! -f "$INSTALL_DIR/.env" ] && cat > "$INSTALL_DIR/.env" << EOF
PORT=${PORT}
PANEL_NAME=HKVM Panel
HKVM_DATA_DIR=$HOME/.hkvm
EOF
        
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
Environment=PORT=${PORT}
[Install]
WantedBy=multi-user.target
EOF
        systemctl daemon-reload 2>/dev/null
        
        echo -e "  ${BLUE}ℹ${NC} Starting HKVM..."
        nohup node app.js > /tmp/hkvm.log 2>&1 &
        sleep 3
        echo -e "  ${GREEN}✓${NC} HKVM installed and running"
        echo -e "  ${WHITE}URL:${NC} http://localhost:${PORT}  ${WHITE}Login:${NC} admin/admin"
        ;;
    2)
        echo -e ""
        if is_running; then echo -e "  ${YELLOW}⚠${NC} Already running"; else
            cd "$INSTALL_DIR" 2>/dev/null && nohup node app.js > /tmp/hkvm.log 2>&1 &
            sleep 3
            is_running && echo -e "  ${GREEN}✓${NC} HKVM started" || echo -e "  ${RED}✗${NC} Failed to start"
        fi
        ;;
    3)
        echo -e ""
        is_running && { pkill -f "node.*app.js"; sleep 1; echo -e "  ${GREEN}✓${NC} HKVM stopped"; } || echo -e "  ${YELLOW}⚠${NC} Not running"
        ;;
    4)
        echo -e ""
        pkill -f "node.*app.js" 2>/dev/null; sleep 2
        cd "$INSTALL_DIR" 2>/dev/null && nohup node app.js > /tmp/hkvm.log 2>&1 &
        sleep 3
        is_running && echo -e "  ${GREEN}✓${NC} HKVM restarted" || echo -e "  ${RED}✗${NC} Failed to restart"
        ;;
    5)
        echo -e ""
        echo -e "  ${WHITE}Open:${NC} http://localhost:${PORT}"
        echo -e "  ${WHITE}Login:${NC} admin / admin"
        command -v xdg-open &>/dev/null && xdg-open "http://localhost:${PORT}" 2>/dev/null &
        ;;
    6)
        echo -e ""
        echo -e "  ${WHITE}OS Templates:${NC}"
        echo -e "  ${GRAY}[1]${NC} Ubuntu 22.04  ${GRAY}[2]${NC} Ubuntu 24.04  ${GRAY}[3]${NC} Debian 12"
        echo -ne "  ${PURPLE}«Select:»${NC} "
        read -r t
        mkdir -p "$VM_DIR/templates"
        case $t in
            1) curl -L -o "$VM_DIR/templates/ubuntu-22.04.qcow2" "https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img" 2>/dev/null && echo -e "  ${GREEN}✓${NC} Downloaded Ubuntu 22.04" ;;
            2) curl -L -o "$VM_DIR/templates/ubuntu-24.04.qcow2" "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img" 2>/dev/null && echo -e "  ${GREEN}✓${NC} Downloaded Ubuntu 24.04" ;;
            3) curl -L -o "$VM_DIR/templates/debian-12.qcow2" "https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-generic-amd64.qcow2" 2>/dev/null && echo -e "  ${GREEN}✓${NC} Downloaded Debian 12" ;;
        esac
        ;;
    7)
        echo -e ""
        echo -ne "  ${RED}Uninstall HKVM? [y/N]:${NC} "
        read -r a
        if [[ "$a" =~ ^[Yy]$ ]]; then
            pkill -f "node.*app.js" 2>/dev/null
            rm -rf "$INSTALL_DIR"
            systemctl disable hkvm 2>/dev/null
            rm -f /etc/systemd/system/hkvm.service
            systemctl daemon-reload 2>/dev/null
            echo -e "  ${GREEN}✓${NC} Uninstalled (data preserved)"
        fi
        ;;
    0) echo -e "  ${GREEN}Goodbye!${NC} 👋"; exit 0 ;;
    *) echo -e "  ${RED}✗${NC} Invalid selection" ;;
esac

echo -e ""
