'use strict';

/**
 * Discord Bot for HKVM Panel
 * Provides slash commands for VM management from Discord
 * Admin-only commands with Discord user ID authorization
 */

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const crypto = require('crypto');

let db = null;
let auditLog = null;
let discordClient = null;
let adminIds = [];

// In-memory store for pending deployments (keyed by Discord user ID)
const pendingDeployments = new Map();

function init(database, audit) {
  db = database;
  auditLog = audit;
  adminIds = (process.env.DISCORD_ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
  console.log(`[Discord] Bot module initialized. Admin IDs: ${adminIds.length} configured`);
}

function isAdmin(userId) {
  return adminIds.includes(userId);
}

/**
 * Start the Discord bot
 */
async function startBot() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.warn('[Discord] No DISCORD_BOT_TOKEN configured. Discord bot disabled.');
    return null;
  }

  discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
    ]
  });

  discordClient.on('ready', async () => {
    console.log(`[Discord] Bot logged in as ${discordClient.user.tag}`);
    await registerSlashCommands();
  });

  discordClient.on('interactionCreate', handleInteraction);

  try {
    await discordClient.login(token);
    return discordClient;
  } catch (err) {
    console.error('[Discord] Failed to login:', err.message);
    return null;
  }
}

/**
 * Register slash commands with Discord API
 */
async function registerSlashCommands() {
  const commands = [
    // /link command
    new SlashCommandBuilder()
      .setName('link')
      .setDescription('Link your HKVM Panel account with Discord')
      .addStringOption(opt => opt.setName('code').setDescription('The 6-character linking code from your panel').setRequired(true)),

    // /unlink command
    new SlashCommandBuilder()
      .setName('unlink')
      .setDescription('Unlink your HKVM Panel account from Discord'),

    // /vm commands (admin only)
    new SlashCommandBuilder()
      .setName('vm')
      .setDescription('Manage virtual machines')
      .addSubcommand(sub => sub
        .setName('deploy')
        .setDescription('Deploy a new virtual machine')
      )
      .addSubcommand(sub => sub
        .setName('list')
        .setDescription('List all virtual machines')
      )
      .addSubcommand(sub => sub
        .setName('status')
        .setDescription('Get VM status')
        .addStringOption(opt => opt.setName('vm').setDescription('VM name or ID').setRequired(true))
      )
      .addSubcommand(sub => sub
        .setName('start')
        .setDescription('Start a VM')
        .addStringOption(opt => opt.setName('vm').setDescription('VM name or ID').setRequired(true))
      )
      .addSubcommand(sub => sub
        .setName('stop')
        .setDescription('Stop a VM')
        .addStringOption(opt => opt.setName('vm').setDescription('VM name or ID').setRequired(true))
      )
      .addSubcommand(sub => sub
        .setName('restart')
        .setDescription('Restart a VM')
        .addStringOption(opt => opt.setName('vm').setDescription('VM name or ID').setRequired(true))
      )
      .addSubcommand(sub => sub
        .setName('delete')
        .setDescription('Delete a VM')
        .addStringOption(opt => opt.setName('vm').setDescription('VM name or ID').setRequired(true))
      ),

    // /lxc commands (admin only)
    new SlashCommandBuilder()
      .setName('lxc')
      .setDescription('Manage LXC containers')
      .addSubcommand(sub => sub
        .setName('deploy')
        .setDescription('Deploy a new LXC container')
      )
      .addSubcommand(sub => sub
        .setName('list')
        .setDescription('List all LXC containers')
      )
      .addSubcommand(sub => sub
        .setName('status')
        .setDescription('Get LXC status')
        .addStringOption(opt => opt.setName('container').setDescription('Container name or ID').setRequired(true))
      )
      .addSubcommand(sub => sub
        .setName('start')
        .setDescription('Start an LXC container')
        .addStringOption(opt => opt.setName('container').setDescription('Container name or ID').setRequired(true))
      )
      .addSubcommand(sub => sub
        .setName('stop')
        .setDescription('Stop an LXC container')
        .addStringOption(opt => opt.setName('container').setDescription('Container name or ID').setRequired(true))
      )
      .addSubcommand(sub => sub
        .setName('restart')
        .setDescription('Restart an LXC container')
        .addStringOption(opt => opt.setName('container').setDescription('Container name or ID').setRequired(true))
      )
      .addSubcommand(sub => sub
        .setName('console')
        .setDescription('Get LXC console info')
        .addStringOption(opt => opt.setName('container').setDescription('Container name or ID').setRequired(true))
      )
      .addSubcommand(sub => sub
        .setName('delete')
        .setDescription('Delete an LXC container')
        .addStringOption(opt => opt.setName('container').setDescription('Container name or ID').setRequired(true))
      ),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  try {
    console.log('[Discord] Registering slash commands...');
    await rest.put(Routes.applicationCommands(discordClient.user.id), { body: commands.map(c => c.toJSON()) });
    console.log('[Discord] Slash commands registered');
  } catch (err) {
    console.error('[Discord] Failed to register commands:', err.message);
  }
}

/**
 * Handle all Discord interactions
 */
async function handleInteraction(interaction) {
  try {
    // /link command - available to all users
    if (interaction.isChatInputCommand() && interaction.commandName === 'link') {
      await handleLinkCommand(interaction);
      return;
    }

    // /unlink command
    if (interaction.isChatInputCommand() && interaction.commandName === 'unlink') {
      await handleUnlinkCommand(interaction);
      return;
    }

    // /vm commands - admin only
    if (interaction.isChatInputCommand() && interaction.commandName === 'vm') {
      if (!isAdmin(interaction.user.id)) {
        await interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
        logDiscordAudit(interaction.user.id, interaction.user.username, 'unauthorized_vm_command', 'FAILURE');
        return;
      }

      const sub = interaction.options.getSubcommand();
      switch (sub) {
        case 'deploy': await handleDeployCommand(interaction); break;
        case 'list': await handleListCommand(interaction); break;
        case 'status': await handleStatusCommand(interaction); break;
        case 'start': await handleStartCommand(interaction); break;
        case 'stop': await handleStopCommand(interaction); break;
        case 'restart': await handleRestartCommand(interaction); break;
        case 'delete': await handleDeleteCommand(interaction); break;
      }
      return;
    }

    // /lxc commands - admin only
    if (interaction.isChatInputCommand() && interaction.commandName === 'lxc') {
      if (!isAdmin(interaction.user.id)) {
        await interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
        logDiscordAudit(interaction.user.id, interaction.user.username, 'unauthorized_lxc_command', 'FAILURE');
        return;
      }
      const sub = interaction.options.getSubcommand();
      switch (sub) {
        case 'deploy': await handleLXCDeployCommand(interaction); break;
        case 'list': await handleLXCListCommand(interaction); break;
        case 'status': await handleLXCStatusCommand(interaction); break;
        case 'start': await handleLXCStartCommand(interaction); break;
        case 'stop': await handleLXCStopCommand(interaction); break;
        case 'restart': await handleLXCRestartCommand(interaction); break;
        case 'console': await handleLXCConsoleCommand(interaction); break;
        case 'delete': await handleLXCDeleteCommand(interaction); break;
      }
      return;
    }

    // Button interactions
    if (interaction.isButton()) {
      if (interaction.customId.startsWith('deploy_confirm_')) {
        await handleDeployConfirm(interaction);
      } else if (interaction.customId === 'deploy_cancel') {
        pendingDeployments.delete(interaction.user.id);
        await interaction.update({ content: '❌ Deployment cancelled.', components: [], embeds: [] });
      }
      return;
    }

    // Modal submissions for deploy
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'deploy_modal') {
        await handleDeployModal(interaction);
      } else if (interaction.customId === 'lxc_deploy_modal') {
        await handleLXCDeployModal(interaction);
      }
      return;
    }
  } catch (err) {
    console.error('[Discord] Interaction error:', err);
    const reply = { content: `❌ Error: ${err.message}`, ephemeral: true };
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply);
      } else {
        await interaction.reply(reply);
      }
    } catch (e) {}
  }
}

/**
 * Handle /link command - verify linking code
 */
async function handleLinkCommand(interaction) {
  const code = interaction.options.getString('code');
  const discordUserId = interaction.user.id;

  // Look up the linking code
  const linkCode = await new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM discord_link_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > datetime('now')`,
      [crypto.createHash('sha256').update(code.toUpperCase()).digest('hex')],
      (err, row) => err ? reject(err) : resolve(row)
    );
  });

  if (!linkCode) {
    await interaction.reply({ content: '❌ Invalid or expired linking code. Please generate a new one from your HKVM Panel profile.', ephemeral: true });
    logDiscordAudit(null, interaction.user.username, 'link_failed', 'FAILURE', `Invalid code attempted: ${code.substring(0, 2)}****`);
    return;
  }

  // Check if Discord user is already linked
  const existingLink = await new Promise((resolve, reject) => {
    db.get(`SELECT * FROM discord_accounts WHERE discord_user_id = ?`, [discordUserId], (err, row) => err ? reject(err) : resolve(row));
  });

  if (existingLink) {
    await interaction.reply({ content: '❌ Your Discord account is already linked to a panel account. Use `/unlink` first.', ephemeral: true });
    return;
  }

  // Check if panel user is already linked
  const existingPanelLink = await new Promise((resolve, reject) => {
    db.get(`SELECT * FROM discord_accounts WHERE panel_user_id = ?`, [linkCode.panel_user_id], (err, row) => err ? reject(err) : resolve(row));
  });

  if (existingPanelLink) {
    await interaction.reply({ content: '❌ This panel account is already linked to a Discord account.', ephemeral: true });
    return;
  }

  // Create the link
  await new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO discord_accounts (panel_user_id, discord_user_id, discord_username) VALUES (?, ?, ?)`,
      [linkCode.panel_user_id, discordUserId, interaction.user.username],
      (err) => err ? reject(err) : resolve()
    );
  });

  // Mark code as used
  await new Promise((resolve, reject) => {
    db.run(`UPDATE discord_link_codes SET used_at = datetime('now') WHERE id = ?`, [linkCode.id], (err) => err ? reject(err) : resolve());
  });

  // Get panel username
  const user = await new Promise((resolve, reject) => {
    db.get(`SELECT username FROM users WHERE id = ?`, [linkCode.panel_user_id], (err, row) => err ? reject(err) : resolve(row));
  });

  await interaction.reply({
    content: `✅ Successfully linked your Discord account to HKVM Panel user: **${user ? user.username : 'Unknown'}**`,
    ephemeral: true
  });

  logDiscordAudit(linkCode.panel_user_id, interaction.user.username, 'discord_linked', 'SUCCESS', `Discord ${discordUserId} linked to panel user ${linkCode.panel_user_id}`);
}

/**
 * Handle /unlink command
 */
async function handleUnlinkCommand(interaction) {
  const discordUserId = interaction.user.id;

  const link = await new Promise((resolve, reject) => {
    db.get(`SELECT * FROM discord_accounts WHERE discord_user_id = ?`, [discordUserId], (err, row) => err ? reject(err) : resolve(row));
  });

  if (!link) {
    await interaction.reply({ content: '❌ Your Discord account is not linked to any panel account.', ephemeral: true });
    return;
  }

  await new Promise((resolve, reject) => {
    db.run(`DELETE FROM discord_accounts WHERE discord_user_id = ?`, [discordUserId], (err) => err ? reject(err) : resolve());
  });

  await interaction.reply({ content: '✅ Your Discord account has been unlinked from HKVM Panel.', ephemeral: true });
  logDiscordAudit(link.panel_user_id, interaction.user.username, 'discord_unlinked', 'SUCCESS');
}

/**
 * Handle /vm deploy - Show modal for deployment configuration
 */
async function handleDeployCommand(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('deploy_modal')
    .setTitle('🚀 VM Deployment');

  const vmNameInput = new TextInputBuilder()
    .setCustomId('vm_name')
    .setLabel('VM Name')
    .setPlaceholder('e.g., ubuntu-01')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(50);

  const osInput = new TextInputBuilder()
    .setCustomId('os_template')
    .setLabel('OS Template')
    .setPlaceholder('e.g., ubuntu_24_cloud, debian_12_cloud')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const cpuInput = new TextInputBuilder()
    .setCustomId('cpus')
    .setLabel('CPU Cores')
    .setPlaceholder('2')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const ramInput = new TextInputBuilder()
    .setCustomId('memory')
    .setLabel('RAM (MB)')
    .setPlaceholder('2048')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const diskInput = new TextInputBuilder()
    .setCustomId('disk_size')
    .setLabel('Disk Size')
    .setPlaceholder('20G')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(vmNameInput),
    new ActionRowBuilder().addComponents(osInput),
    new ActionRowBuilder().addComponents(cpuInput),
    new ActionRowBuilder().addComponents(ramInput),
    new ActionRowBuilder().addComponents(diskInput)
  );

  await interaction.showModal(modal);
}

/**
 * Handle deploy modal submission - Show confirmation
 */
async function handleDeployModal(interaction) {
  const vmName = interaction.fields.getTextInputValue('vm_name');
  const osTemplate = interaction.fields.getTextInputValue('os_template');
  const cpus = parseInt(interaction.fields.getTextInputValue('cpus')) || 2;
  const memory = parseInt(interaction.fields.getTextInputValue('memory')) || 2048;
  const diskSize = interaction.fields.getTextInputValue('disk_size') || '20G';

  // Store deployment data for confirmation
  pendingDeployments.set(interaction.user.id, {
    vmName, osTemplate, cpus, memory, diskSize,
    discordUserId: interaction.user.id,
    timestamp: Date.now()
  });

  const embed = new EmbedBuilder()
    .setTitle('🚀 VM Deployment')
    .setColor(0x6366F1)
    .addFields(
      { name: 'VM Name', value: vmName, inline: true },
      { name: 'OS Template', value: osTemplate, inline: true },
      { name: 'CPU', value: `${cpus} cores`, inline: true },
      { name: 'RAM', value: `${memory} MB`, inline: true },
      { name: 'Disk', value: diskSize, inline: true },
    )
    .setFooter({ text: 'Please confirm to deploy' });

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`deploy_confirm_${interaction.user.id}`)
      .setLabel('Confirm Deployment')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('deploy_cancel')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger)
  );

  await interaction.reply({ embeds: [embed], components: [confirmRow], ephemeral: true });
}

/**
 * Handle deploy confirmation - Actually deploy the VM
 */
async function handleDeployConfirm(interaction) {
  const data = pendingDeployments.get(interaction.user.id);
  if (!data) {
    await interaction.update({ content: '❌ Deployment session expired. Run /vm deploy again.', components: [], embeds: [] });
    return;
  }

  pendingDeployments.delete(interaction.user.id);

  // Defer the reply since deployment takes time
  await interaction.update({ content: '🚀 **VM Deployment Started**\n\nVM: ' + data.vmName + '\nStatus: Creating...', components: [], embeds: [] });

  try {
    // Find the panel user ID from Discord link
    const link = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM discord_accounts WHERE discord_user_id = ?`, [data.discordUserId], (err, row) => err ? reject(err) : resolve(row));
    });

    const ownerId = link ? link.panel_user_id : 1; // Default to admin if no link

    // Build VM creation data (reuse existing VM creation logic)
    const { execSync } = require('child_process');
    const path = require('path');
    const os = require('os');

    const VM_DIR = path.join(os.homedir(), 'vms');
    const CLOUDVM_DIR = path.join(VM_DIR, 'cloudvm');
    const TEMPLATES_DIR = path.join(VM_DIR, 'templates');

    // Insert VM record
    const vmId = await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO vms (vm_name, os_type, template_type, hostname, username, password,
          memory, cpus, cpu_sockets, cpu_cores, cpu_threads, cpu_model,
          disk_size, status, network_type, owner_id, smbios_manufacturer, smbios_serial)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, 'host', ?, 'stopped', 'dhcp', ?, 'QEMU', ?)`,
        [
          data.vmName, data.osTemplate, data.osTemplate, data.vmName,
          'ubuntu', 'ubuntu', data.memory, data.cpus, data.cpus,
          data.diskSize, ownerId, `vm-${Date.now()}`
        ],
        function(err) { err ? reject(err) : resolve(this.lastID); }
      );
    });

    // Update with file paths
    const diskFile = path.join(VM_DIR, `vm-${vmId}-disk.qcow2`);
    const seedFile = path.join(VM_DIR, `vm-${vmId}-seed.iso`);
    const imgFile = path.join(CLOUDVM_DIR, `${data.osTemplate}-${vmId}.qcow2`);

    await new Promise((resolve, reject) => {
      db.run(`UPDATE vms SET img_file = ?, seed_file = ?, disk_file = ? WHERE vm_id = ?`,
        [imgFile, seedFile, diskFile, vmId], (err) => err ? reject(err) : resolve());
    });

    // Create disk
    const createDiskCmd = `qemu-img create -f qcow2 "${diskFile}" ${data.diskSize}`;
    execSync(createDiskCmd, { stdio: 'pipe' });

    // Send success response
    const successEmbed = new EmbedBuilder()
      .setTitle('✅ VM Deployment Completed')
      .setColor(0x10B981)
      .addFields(
        { name: 'VM', value: data.vmName, inline: true },
        { name: 'ID', value: `#${vmId}`, inline: true },
        { name: 'Status', value: 'Created (Stopped)', inline: true },
        { name: 'Template', value: data.osTemplate, inline: true },
        { name: 'Credentials', value: 'ubuntu / ubuntu', inline: true },
      )
      .setFooter({ text: `VM ID: ${vmId} | Start with /vm start ${vmId}` });

    await interaction.editReply({ embeds: [successEmbed] });

    logDiscordAudit(ownerId, interaction.user.username, 'vm_deploy', 'SUCCESS', `VM ${data.vmName} (ID: ${vmId}) deployed from Discord`);
  } catch (err) {
    await interaction.editReply({ content: `❌ Deployment failed: ${err.message}` });
    logDiscordAudit(null, interaction.user.username, 'vm_deploy', 'FAILURE', err.message);
  }
}

/**
 * Handle /vm list
 */
async function handleListCommand(interaction) {
  const vms = await new Promise((resolve, reject) => {
    db.all(`SELECT vm_id, vm_name, status, os_type, memory, cpus FROM vms ORDER BY vm_id DESC`, [], (err, rows) => err ? reject(err) : resolve(rows || []));
  });

  if (vms.length === 0) {
    await interaction.reply({ content: '📋 No VMs found.', ephemeral: true });
    return;
  }

  const list = vms.map(vm => {
    const status = vm.status === 'running' ? '🟢' : vm.status === 'stopped' ? '🔴' : '🟡';
    return `${status} **#${vm.vm_id}** ${vm.vm_name} — ${vm.status} — ${vm.cpus}CPU / ${vm.memory}MB`;
  }).join('\n');

  const embed = new EmbedBuilder()
    .setTitle('📋 Virtual Machines')
    .setDescription(list.substring(0, 4000))
    .setColor(0x6366F1)
    .setFooter({ text: `Total: ${vms.length} VMs` });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

/**
 * Helper: Find VM by name or ID
 */
async function findVM(identifier) {
  const id = parseInt(identifier);
  if (!isNaN(id)) {
    return await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM vms WHERE vm_id = ?`, [id], (err, row) => err ? reject(err) : resolve(row));
    });
  }
  return await new Promise((resolve, reject) => {
    db.get(`SELECT * FROM vms WHERE vm_name LIKE ?`, [`%${identifier}%`], (err, row) => err ? reject(err) : resolve(row));
  });
}

/**
 * Handle /vm status
 */
async function handleStatusCommand(interaction) {
  const vm = await findVM(interaction.options.getString('vm'));
  if (!vm) { await interaction.reply({ content: '❌ VM not found.', ephemeral: true }); return; }

  const status = vm.status === 'running' ? '🟢 Running' : vm.status === 'stopped' ? '🔴 Stopped' : `🟡 ${vm.status}`;
  const embed = new EmbedBuilder()
    .setTitle(`VM: ${vm.vm_name}`)
    .setColor(vm.status === 'running' ? 0x10B981 : 0xEF4444)
    .addFields(
      { name: 'Status', value: status, inline: true },
      { name: 'ID', value: `#${vm.vm_id}`, inline: true },
      { name: 'OS', value: vm.os_type || 'Unknown', inline: true },
      { name: 'CPU', value: `${vm.cpus} cores`, inline: true },
      { name: 'RAM', value: `${vm.memory} MB`, inline: true },
      { name: 'Disk', value: vm.disk_size || 'N/A', inline: true },
      { name: 'Network', value: vm.network_type || 'DHCP', inline: true },
      { name: 'IP', value: vm.ipv4_address || 'DHCP', inline: true }
    );

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

/**
 * Handle /vm start
 */
async function handleStartCommand(interaction) {
  const vm = await findVM(interaction.options.getString('vm'));
  if (!vm) { await interaction.reply({ content: '❌ VM not found.', ephemeral: true }); return; }
  if (vm.status === 'running') { await interaction.reply({ content: `⚠️ VM ${vm.vm_name} is already running.`, ephemeral: true }); return; }

  try {
    // Import and use startQemuVM from app.js - we'll use a simpler approach
    const { execSync } = require('child_process');
    const path = require('path');
    const pidFile = path.join(require('os').homedir(), 'vms', `vm-${vm.vm_id}.pid`);

    // Check if disk exists
    if (!vm.disk_file || !require('fs').existsSync(vm.disk_file)) {
      await interaction.reply({ content: `❌ VM ${vm.vm_name} disk file not found.`, ephemeral: true });
      return;
    }

    // Build QEMU command
    const args = [
      `-m ${vm.memory}`,
      `-smp cores=${vm.cpu_cores},threads=${vm.cpu_threads},sockets=${vm.cpu_sockets}`,
      `-cpu ${vm.cpu_model || 'host'}`,
      `-name vm-${vm.vm_id}`,
      `-machine ${vm.machine_type || 'pc'},accel=kvm:tcg`,
      `-enable-kvm`,
      `-nographic`,
      `-drive file=${vm.disk_file},format=qcow2,if=virtio,media=disk`,
      `-netdev user,id=net0,hostfwd=tcp::${vm.ssh_port || 22}-:22`,
      `-device virtio-net-pci,netdev=net0`,
      `-vnc 127.0.0.1:${5900 + vm.vm_id}`,
      `-serial mon:stdio`
    ];

    // Seed ISO
    if (vm.seed_file && require('fs').existsSync(vm.seed_file)) {
      args.push(`-drive file=${vm.seed_file},format=raw,media=cdrom,if=ide,index=1`);
    }

    // Start QEMU in background
    const qemuCmd = `nohup qemu-system-x86_64 ${args.join(' ')} > /dev/null 2>&1 & echo $!`;
    const { stdout } = require('child_process').execSync(qemuCmd, { shell: '/bin/bash', encoding: 'utf8' });
    const pid = parseInt(stdout.trim());

    if (pid) {
      require('fs').writeFileSync(pidFile, String(pid));
      db.run(`UPDATE vms SET status = 'running' WHERE vm_id = ?`, [vm.vm_id]);

      await interaction.reply({ content: `✅ VM **${vm.vm_name}** started (PID: ${pid})` });
      logDiscordAudit(1, interaction.user.username, 'vm_start', 'SUCCESS', `VM ${vm.vm_name} (ID: ${vm.vm_id}) started`);
    } else {
      await interaction.reply({ content: `❌ Failed to start VM ${vm.vm_name}` });
    }
  } catch (err) {
    await interaction.reply({ content: `❌ Failed to start VM: ${err.message}` });
    logDiscordAudit(1, interaction.user.username, 'vm_start', 'FAILURE', err.message);
  }
}

/**
 * Handle /vm stop
 */
async function handleStopCommand(interaction) {
  const vm = await findVM(interaction.options.getString('vm'));
  if (!vm) { await interaction.reply({ content: '❌ VM not found.', ephemeral: true }); return; }
  if (vm.status === 'stopped') { await interaction.reply({ content: `⚠️ VM ${vm.vm_name} is already stopped.`, ephemeral: true }); return; }

  try {
    const path = require('path');
    const fs = require('fs');
    const pidFile = path.join(require('os').homedir(), 'vms', `vm-${vm.vm_id}.pid`);

    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
      try { require('child_process').execSync(`kill -9 ${pid}`, { stdio: 'pipe' }); } catch (e) {}
      fs.unlinkSync(pidFile);
    }

    db.run(`UPDATE vms SET status = 'stopped' WHERE vm_id = ?`, [vm.vm_id]);
    await interaction.reply({ content: `✅ VM **${vm.vm_name}** stopped.` });
    logDiscordAudit(1, interaction.user.username, 'vm_stop', 'SUCCESS', `VM ${vm.vm_name} (ID: ${vm.vm_id}) stopped`);
  } catch (err) {
    await interaction.reply({ content: `❌ Failed to stop VM: ${err.message}` });
  }
}

/**
 * Handle /vm restart
 */
async function handleRestartCommand(interaction) {
  await handleStopCommand(interaction);
  setTimeout(async () => {
    const vm = await findVM(interaction.options.getString('vm'));
    if (vm) await handleStartCommand(interaction);
  }, 2000);
}

/**
 * Handle /vm delete
 */
async function handleDeleteCommand(interaction) {
  const vm = await findVM(interaction.options.getString('vm'));
  if (!vm) { await interaction.reply({ content: '❌ VM not found.', ephemeral: true }); return; }

  try {
    const fs = require('fs');
    const path = require('path');
    const pidFile = path.join(require('os').homedir(), 'vms', `vm-${vm.vm_id}.pid`);

    // Kill process
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
      try { require('child_process').execSync(`kill -9 ${pid}`, { stdio: 'pipe' }); } catch (e) {}
      fs.unlinkSync(pidFile);
    }

    // Delete files
    if (vm.img_file && fs.existsSync(vm.img_file)) try { fs.unlinkSync(vm.img_file); } catch (e) {}
    if (vm.seed_file && fs.existsSync(vm.seed_file)) try { fs.unlinkSync(vm.seed_file); } catch (e) {}
    if (vm.disk_file && fs.existsSync(vm.disk_file)) try { fs.unlinkSync(vm.disk_file); } catch (e) {}

    // Delete from database
    db.run(`DELETE FROM vms WHERE vm_id = ?`, [vm.vm_id]);
    db.run(`DELETE FROM vm_logs WHERE vm_id = ?`, [vm.vm_id]);
    db.run(`DELETE FROM vm_snapshots WHERE vm_id = ?`, [vm.vm_id]);

    await interaction.reply({ content: `🗑️ VM **${vm.vm_name}** (ID: ${vm.vm_id}) deleted.` });
    logDiscordAudit(1, interaction.user.username, 'vm_delete', 'SUCCESS', `VM ${vm.vm_name} (ID: ${vm.vm_id}) deleted from Discord`);
  } catch (err) {
    await interaction.reply({ content: `❌ Failed to delete VM: ${err.message}` });
  }
}

// ============= LXC Commands =============

async function handleLXCDeployModal(interaction) {
  const name = interaction.fields.getTextInputValue('name');
  const template = interaction.fields.getTextInputValue('template');
  const cpu = parseInt(interaction.fields.getTextInputValue('cpu')) || 2;
  const memory = parseInt(interaction.fields.getTextInputValue('memory')) || 2048;
  const disk = interaction.fields.getTextInputValue('disk') || '20G';

  await interaction.reply({ content: '🚀 Deploying LXC container **' + name + '**...', ephemeral: true });
  try {
    const internalSecret = process.env.INTERNAL_API_SECRET || '';
    const res = await fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/internal/discord/lxc', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Api-Secret': internalSecret },
      body: JSON.stringify({ name, template_key: template, cpu_cores: cpu, memory, disk_size: disk, password: 'password' })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    const embed = new EmbedBuilder().setTitle('✅ LXC Deployed').setColor(0x10B981)
      .addFields({ name: 'Container', value: name, inline: true }, { name: 'ID', value: '#' + data.id, inline: true },
        { name: 'Node', value: data.node || 'auto', inline: true },
        { name: 'CPU', value: cpu + ' cores', inline: true }, { name: 'RAM', value: memory + ' MB', inline: true }, { name: 'Disk', value: disk, inline: true });
    await interaction.editReply({ content: '', embeds: [embed] });
    logDiscordAudit(1, interaction.user.username, 'lxc_deploy', 'SUCCESS', 'LXC ' + name + ' deployed');
  } catch (err) {
    await interaction.editReply({ content: '❌ Deployment failed: ' + err.message });
  }
}

async function handleLXCDeployCommand(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('lxc_deploy_modal')
    .setTitle('📦 LXC Container Deployment');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Container Name').setPlaceholder('e.g., ubuntu-lxc-01').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('template').setLabel('Template (e.g., ubuntu_24_lxc, debian_12_lxc)').setPlaceholder('e.g., ubuntu_24_lxc').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cpu').setLabel('CPU Cores').setPlaceholder('2').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('memory').setLabel('RAM (MB)').setPlaceholder('2048').setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('disk').setLabel('Disk Size').setPlaceholder('20G').setStyle(TextInputStyle.Short).setRequired(true))
  );
  await interaction.showModal(modal);
}

async function handleLXCListCommand(interaction) {
  const internalSecret = process.env.INTERNAL_API_SECRET || '';
  const listRes = await fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/internal/discord/lxcs', {
    headers: { 'X-Internal-Api-Secret': internalSecret }
  });
  const containers = listRes.ok ? await listRes.json() : [];
  if (containers.length === 0) { await interaction.reply({ content: '📋 No LXC containers found.', ephemeral: true }); return; }
  const list = containers.map(c => {
    const s = c.status === 'running' ? '🟢' : '🔴';
    return `${s} **#${c.id}** ${c.name} - ${c.status} - ${c.cpu_cores}CPU / ${c.memory}MB`;
  }).join('\n');
  const embed = new EmbedBuilder().setTitle('📦 LXC Containers').setDescription(list.substring(0, 4000)).setColor(0x6366F1).setFooter({ text: 'Total: ' + containers.length + ' containers' });
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleLXCStatusCommand(interaction) {
  const id = parseInt(interaction.options.getString('container'));
  const internalSecret = process.env.INTERNAL_API_SECRET || '';
  const statusRes = await fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/internal/discord/lxc/' + id, {
    headers: { 'X-Internal-Api-Secret': internalSecret }
  });
  const container = statusRes.ok ? await statusRes.json() : null;
  if (!container) { await interaction.reply({ content: '❌ Container not found.', ephemeral: true }); return; }
  const embed = new EmbedBuilder()
    .setTitle('Container: ' + container.name)
    .setColor(container.status === 'running' ? 0x10B981 : 0xEF4444)
    .addFields(
      { name: 'Status', value: container.status === 'running' ? '🟢 Running' : '🔴 Stopped', inline: true },
      { name: 'ID', value: '#' + container.id, inline: true },
      { name: 'CPU', value: container.cpu_cores + ' cores', inline: true },
      { name: 'RAM', value: container.memory + ' MB', inline: true },
      { name: 'Disk', value: container.disk_size || 'N/A', inline: true },
      { name: 'IP', value: container.ipv4_address || 'DHCP', inline: true }
    );
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleLXCStartCommand(interaction) {
  const id = parseInt(interaction.options.getString('container'));
  try {
    const internalSecret = process.env.INTERNAL_API_SECRET || '';
    const res = await fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/internal/discord/lxc/' + id + '/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Api-Secret': internalSecret }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    await interaction.reply({ content: '✅ ' + data.message });
    logDiscordAudit(1, interaction.user.username, 'lxc_start', 'SUCCESS', 'LXC ' + id + ' started');
  } catch (err) { await interaction.reply({ content: '❌ Failed: ' + err.message }); }
}

async function handleLXCStopCommand(interaction) {
  const id = parseInt(interaction.options.getString('container'));
  try {
    const internalSecret = process.env.INTERNAL_API_SECRET || '';
    const res = await fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/internal/discord/lxc/' + id + '/stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Api-Secret': internalSecret }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    await interaction.reply({ content: '✅ ' + data.message });
    logDiscordAudit(1, interaction.user.username, 'lxc_stop', 'SUCCESS', 'LXC ' + id + ' stopped');
  } catch (err) { await interaction.reply({ content: '❌ Failed: ' + err.message }); }
}

async function handleLXCRestartCommand(interaction) {
  const id = parseInt(interaction.options.getString('container'));
  try {
    const internalSecret = process.env.INTERNAL_API_SECRET || '';
    const res = await fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/internal/discord/lxc/' + id + '/restart', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Api-Secret': internalSecret }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    await interaction.reply({ content: '✅ ' + data.message });
  } catch (err) { await interaction.reply({ content: '❌ Failed: ' + err.message }); }
}

async function handleLXCConsoleCommand(interaction) {
  const id = parseInt(interaction.options.getString('container'));
  try {
    const internalSecret = process.env.INTERNAL_API_SECRET || '';
    const res = await fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/internal/discord/lxc/' + id + '/console', {
      headers: { 'X-Internal-Api-Secret': internalSecret }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    await interaction.reply({ content: '🖥️ Console URL: ' + (data.url || data.message || JSON.stringify(data)), ephemeral: true });
  } catch (err) { await interaction.reply({ content: '❌ Failed: ' + err.message, ephemeral: true }); }
}

async function handleLXCDeleteCommand(interaction) {
  const id = parseInt(interaction.options.getString('container'));
  try {
    const internalSecret = process.env.INTERNAL_API_SECRET || '';
    const res = await fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/internal/discord/lxc/' + id, {
      method: 'DELETE', headers: { 'X-Internal-Api-Secret': internalSecret }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    await interaction.reply({ content: '🗑️ ' + data.message });
    logDiscordAudit(1, interaction.user.username, 'lxc_delete', 'SUCCESS', 'LXC ' + id + ' deleted');
  } catch (err) { await interaction.reply({ content: '❌ Failed: ' + err.message }); }
}

/**
 * Log Discord audit event
 */
function logDiscordAudit(userId, username, action, result, details = null) {
  if (auditLog) {
    auditLog.log({
      userId,
      username,
      action,
      resourceType: 'discord',
      details,
      source: 'discord',
      result
    });
  }
}

function getClient() { return discordClient; }

module.exports = { init, startBot, getClient, isAdmin };
