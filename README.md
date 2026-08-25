# 🖥️ HKVM Panel

**Advanced VM Management & Control Panel powered by QEMU/KVM**

A self-hosted web panel for managing virtual machines, LXC containers, and Proxmox nodes — all from one dashboard.

---

## ✨ Features

- 🖥️ **QEMU/KVM VM Management** — Create, start, stop, delete VMs with full hardware config
- 📦 **LXC Containers** — Manage local LXD and Proxmox LXC containers
- 🌐 **Multi-Node Support** — Connect multiple Proxmox VE nodes
- 🖥️ **noVNC Console** — Browser-based VM console access
- 🔑 **tmate Sessions** — One-click SSH sharing
- 🤖 **Discord Bot** — Manage VMs from Discord
- 📊 **Health Monitoring** — Real-time node health checks
- 🌐 **IP Allocation** — Automatic IP management
- 📋 **Audit Logging** — Track all actions
- 🔒 **Role-Based Access** — Admin and user roles

---

## 🚀 Quick Install

### One-Line Install (Recommended)
```bash
curl -sL https://raw.githubusercontent.com/novavcrp-elite/hkvm/main/setup.sh | sudo bash
```

### Interactive Installer
```bash
curl -sL https://raw.githubusercontent.com/novavcrp-elite/hkvm/main/install.sh | sudo bash
```

### Manual Install
```bash
# Clone the repo
git clone https://github.com/novavcrp-elite/hkvm.git /opt/hkvm
cd /opt/hkvm

# Install dependencies
npm install --production

# Configure
cp .env.example .env
nano .env

# Start
node app.js
```

---

## ⚙️ Configuration

Create `/opt/hkvm/.env` with:

```env
# Server
PORT=8080
PANEL_NAME=HKVM Panel
PANEL_VERSION=V1.0

# Paths
HKVM_DATA_DIR=/root/.hkvm

# Logo
DEFAULT_LOGO_URL=https://i.imgur.com/0DmkSi4.png

# Discord Bot (Optional)
DISCORD_BOT_TOKEN=your_token_here
DISCORD_ADMIN_IDS=123456789,987654321
INTERNAL_API_SECRET=your_secret_here
```

---

## 📁 Directory Structure

```
/opt/hkvm/           # Installation directory
├── app.js           # Main application
├── lxc.js           # LXC container management
├── local-lxd.js     # Local LXD integration
├── proxmox-api.js   # Proxmox API client
├── discord-bot.js   # Discord bot
├── views/           # EJS templates
└── public/          # Static files

~/.hkvm/             # Data directory
└── hkvm.db          # SQLite database

~/vms/               # VM files
├── templates/       # OS templates
├── iso/             # ISO files
└── cloudvm/         # Cloud images
```

---

## 🔧 Management Commands

```bash
# Start HKVM
bash /opt/hkvm/install.sh
# Then select [2] Turn ON

# Or use systemd
systemctl start hkvm
systemctl stop hkvm
systemctl restart hkvm
systemctl status hkvm

# View logs
journalctl -u hkvm -f
tail -f /tmp/hkvm.log
```

---

## 🐳 Docker Support

HKVM can detect and manage Docker containers on the host.

---

## 📋 Requirements

- **OS**: Ubuntu 20.04+ / Debian 11+ / CentOS 8+
- **Node.js**: 18+ (auto-installed)
- **RAM**: 512MB minimum
- **Disk**: 1GB minimum
- **KVM**: For VM support (optional)

---

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing`)
5. Open a Pull Request

---

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.

---

## 🙏 Credits

- **QEMU/KVM** — Virtualization
- **LXD** — Container management
- **Proxmox VE** — Enterprise virtualization
- **Express.js** — Web framework
- **SQLite** — Database
- **Discord.js** — Discord bot

---

<div align="center">

**Made with ❤️ by HopingBoyZ**

[![GitHub](https://img.shields.io/badge/GitHub-HKVM-181717?style=for-the-badge&logo=github)](https://github.com/novavcrp-elite/hkvm)

</div>
