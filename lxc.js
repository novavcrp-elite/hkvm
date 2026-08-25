'use strict';

/**
 * LXC Container Management Module for HKVM Panel
 * Handles LXC lifecycle, console, tmate, clone, rebuild
 */

const proxmoxApi = require('./proxmox-api');
const localLxd = require('./local-lxd');
const crypto = require('crypto');

let db = null;
let auditLog = null;

function init(database, audit) {
  db = database;
  auditLog = audit;

  // Create lxc_containers table
  db.run(`CREATE TABLE IF NOT EXISTS lxc_containers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    container_id INTEGER,
    name TEXT NOT NULL,
    owner_id INTEGER,
    node_id INTEGER,
    template_key TEXT,
    os_type TEXT,
    status TEXT DEFAULT 'stopped',
    cpu_cores INTEGER DEFAULT 2,
    memory INTEGER DEFAULT 2048,
    swap INTEGER DEFAULT 2048,
    disk_size TEXT DEFAULT '20G',
    disk_used REAL DEFAULT 0,
    ipv4_address TEXT,
    ipv6_address TEXT,
    gateway TEXT,
    netmask TEXT DEFAULT '24',
    bridge TEXT DEFAULT 'vmbr0',
    vlan_id INTEGER,
    hostname TEXT,
    username TEXT,
    password TEXT,
    ssh_port INTEGER DEFAULT 22,
    network_type TEXT DEFAULT 'dhcp',
    dns_servers TEXT DEFAULT '8.8.8.8,8.8.4.4',
    unprivileged BOOLEAN DEFAULT 1,
    nesting BOOLEAN DEFAULT 1,
    description TEXT,
    last_activity DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(owner_id) REFERENCES users(id),
    FOREIGN KEY(node_id) REFERENCES nodes(id)
  )`);

  // Create lxc_configs table for type-specific configuration
  db.run(`CREATE TABLE IF NOT EXISTS lxc_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    container_id INTEGER UNIQUE NOT NULL,
    mount_points TEXT,
    features TEXT,
    hooks TEXT,
    labels TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(container_id) REFERENCES lxc_containers(id)
  )`);

  // Create lxc_logs table
  db.run(`CREATE TABLE IF NOT EXISTS lxc_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    container_id INTEGER,
    action TEXT,
    status TEXT,
    message TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(container_id) REFERENCES lxc_containers(id)
  )`);

  console.log('[LXC] LXC container management initialized');
}

// ============= CRUD Operations =============

async function createContainer(data, userId, ipAddress) {
  const { name, node_id, template_key, cpu_cores, memory, swap, disk_size,
    ipv4_address, ipv6_address, gateway, netmask, bridge, vlan_id,
    hostname, username, password, network_type, description } = data;

  if (!name) throw new Error('Container name is required');

  // Validate resource limits first
  const validatedCpu = Math.min(Math.max(parseInt(cpu_cores) || 2, 1), 128);
  const validatedMemory = Math.min(Math.max(parseInt(memory) || 2048, 128), 1048576);
  const validatedSwap = Math.min(Math.max(parseInt(swap) || validatedMemory, 0), 1048576);

  // Get the node - auto-select if node_id not provided or is 'auto'
  let node;
  if (!node_id || node_id === 'auto') {
    // Auto-select: prefer local LXD if available, then best Proxmox node
    const localLxdNode = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM nodes WHERE api_type = 'local-lxd' AND status != 'deleted' AND enabled = 1`,
        [], (err, row) => err ? reject(err) : resolve(row));
    });
    if (localLxdNode) {
      node = localLxdNode;
    } else {
      // Fall back to auto-select best Proxmox node
      node = await proxmoxApi.autoSelectNode(db, userId, {
        memory: validatedMemory / 1024,
        disk: parseInt(String(disk_size).replace(/[^0-9]/g, '')) || 20
      });
    }
  } else {
    node = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM nodes WHERE id = ? AND status != 'deleted' AND enabled = 1`,
        [node_id], (err, row) => err ? reject(err) : resolve(row));
    });
  }
  if (!node) throw new Error('Node not found or not available');

  // Check if this is a local LXD node
  const isLocalLxd = node.api_type === 'local-lxd';

  let vmid;
  if (isLocalLxd) {
    // Create using local LXD CLI
    try {
      // Map template_key to LXD image alias
      const imageMap = {
        'ubuntu_24_lxc': 'images:ubuntu/24.04',
        'ubuntu_22_lxc': 'images:ubuntu/22.04',
        'debian_12_lxc': 'images:debian/12',
        'alpine_lxc': 'images:alpine/edge',
        'centos_9_lxc': 'images:centos/9-Stream'
      };
      const image = imageMap[template_key] || template_key || 'images:ubuntu/24.04';

      const result = await localLxd.createContainer({
        name,
        image,
        cpu_cores: validatedCpu,
        memory: validatedMemory,
        swap: validatedSwap,
        disk_size: disk_size || '20G',
        ipv4_address,
        gateway,
        netmask: netmask || '24',
        hostname: hostname || name,
        password: password || 'password',
        bridge: bridge || 'lxdbr0',
        network_type: network_type || 'dhcp',
        description: description || ''
      });
      vmid = name; // Use name as container_id for local LXD
    } catch (err) {
      throw new Error(`Local LXD creation failed: ${err.message}`);
    }
  } else {
    // Create on Proxmox
    try {
      const result = await proxmoxApi.createLXC(node, {
        name,
        hostname: hostname || name,
        cores: validatedCpu,
        memory: validatedMemory,
        swap: validatedSwap,
        disk_size: disk_size || '20G',
        template: template_key,
        ipv4_address,
        ipv6_address,
        netmask: netmask || '24',
        bridge: bridge || 'vmbr0',
        password: password || 'password',
        unprivileged: true,
        features: 'nesting=1'
      });
      vmid = result.vmid;
    } catch (err) {
      throw new Error(`Proxmox LXC creation failed: ${err.message}`);
    }
  }

  // Insert into database
  const containerId = await new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO lxc_containers (container_id, name, owner_id, node_id, template_key, os_type,
        cpu_cores, memory, swap, disk_size, ipv4_address, ipv6_address, gateway, netmask, bridge, vlan_id,
        hostname, username, password, network_type, description, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [vmid, name, userId, node_id, template_key, template_key,
        validatedCpu, validatedMemory, validatedSwap, disk_size || '20G',
        ipv4_address || null, ipv6_address || null, gateway || null,
        netmask || '24', bridge || (isLocalLxd ? 'lxdbr0' : 'vmbr0'), vlan_id || null,
        hostname || name, username || 'root', password || 'password',
        network_type || 'dhcp', description || '',
        isLocalLxd ? 'running' : 'stopped'],
      function(err) { err ? reject(err) : resolve(this.lastID); }
    );
  });

  logLXCAction(containerId, 'create', 'success', `LXC container ${name} created on ${isLocalLxd ? 'local LXD' : node.name}`);

  return { id: containerId, container_id: vmid, name, node: isLocalLxd ? 'local-lxd' : node.name };
}

async function getContainer(id, userId, isAdmin) {
  const query = isAdmin
    ? `SELECT lxc.*, n.name as node_name, n.hostname as node_hostname FROM lxc_containers lxc LEFT JOIN nodes n ON lxc.node_id = n.id WHERE lxc.id = ?`
    : `SELECT lxc.*, n.name as node_name, n.hostname as node_hostname FROM lxc_containers lxc LEFT JOIN nodes n ON lxc.node_id = n.id WHERE lxc.id = ? AND lxc.owner_id = ?`;
  const params = isAdmin ? [id] : [id, userId];

  return new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => err ? reject(err) : resolve(row));
  });
}

async function listContainers(userId, isAdmin) {
  const query = isAdmin
    ? `SELECT lxc.*, n.name as node_name FROM lxc_containers lxc LEFT JOIN nodes n ON lxc.node_id = n.id WHERE lxc.status != 'deleted' ORDER BY lxc.created_at DESC`
    : `SELECT lxc.*, n.name as node_name FROM lxc_containers lxc LEFT JOIN nodes n ON lxc.node_id = n.id WHERE lxc.owner_id = ? AND lxc.status != 'deleted' ORDER BY lxc.created_at DESC`;
  const params = isAdmin ? [] : [userId];

  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => err ? reject(err) : resolve(rows || []));
  });
}

// ============= Lifecycle Operations =============

async function startContainer(id, userId, isAdmin) {
  const container = await getContainer(id, userId, isAdmin);
  if (!container) throw new Error('Container not found or access denied');
  if (container.status === 'running') throw new Error('Container is already running');

  const node = await getNodeForContainer(container);
  const isLocalLxd = node.api_type === 'local-lxd';

  if (isLocalLxd) {
    await localLxd.startContainer(container.name);
  } else {
    await proxmoxApi.startLXC(node, container.container_id);
  }

  db.run(`UPDATE lxc_containers SET status = 'running', last_activity = datetime('now'), updated_at = datetime('now') WHERE id = ?`, [id]);
  logLXCAction(id, 'start', 'success', `Container ${container.name} started on ${isLocalLxd ? 'local LXD' : node.name}`);

  return { success: true, message: `Container ${container.name} started` };
}

async function stopContainer(id, userId, isAdmin) {
  const container = await getContainer(id, userId, isAdmin);
  if (!container) throw new Error('Container not found or access denied');
  if (container.status === 'stopped') throw new Error('Container is already stopped');

  const node = await getNodeForContainer(container);
  const isLocalLxd = node.api_type === 'local-lxd';

  if (isLocalLxd) {
    await localLxd.stopContainer(container.name);
  } else {
    await proxmoxApi.stopLXC(node, container.container_id);
  }

  db.run(`UPDATE lxc_containers SET status = 'stopped', last_activity = datetime('now'), updated_at = datetime('now') WHERE id = ?`, [id]);
  logLXCAction(id, 'stop', 'success', `Container ${container.name} stopped`);

  return { success: true, message: `Container ${container.name} stopped` };
}

async function restartContainer(id, userId, isAdmin) {
  const container = await getContainer(id, userId, isAdmin);
  if (!container) throw new Error('Container not found or access denied');

  const node = await getNodeForContainer(container);
  const isLocalLxd = node.api_type === 'local-lxd';

  if (isLocalLxd) {
    await localLxd.restartContainer(container.name);
  } else {
    await proxmoxApi.restartLXC(node, container.container_id);
  }

  db.run(`UPDATE lxc_containers SET last_activity = datetime('now'), updated_at = datetime('now') WHERE id = ?`, [id]);
  logLXCAction(id, 'restart', 'success', `Container ${container.name} restarted`);

  return { success: true, message: `Container ${container.name} restarted` };
}

async function shutdownContainer(id, userId, isAdmin) {
  const container = await getContainer(id, userId, isAdmin);
  if (!container) throw new Error('Container not found or access denied');
  if (container.status !== 'running') throw new Error('Container is not running');

  const node = await getNodeForContainer(container);
  const isLocalLxd = node.api_type === 'local-lxd';

  if (isLocalLxd) {
    await localLxd.shutdownContainer(container.name);
  } else {
    await proxmoxApi.shutdownLXC(node, container.container_id);
  }

  db.run(`UPDATE lxc_containers SET status = 'stopped', last_activity = datetime('now'), updated_at = datetime('now') WHERE id = ?`, [id]);
  logLXCAction(id, 'shutdown', 'success', `Container ${container.name} shut down gracefully`);

  return { success: true, message: `Container ${container.name} shut down` };
}

async function rebootContainer(id, userId, isAdmin) {
  const container = await getContainer(id, userId, isAdmin);
  if (!container) throw new Error('Container not found or access denied');
  if (container.status !== 'running') throw new Error('Container is not running');

  const node = await getNodeForContainer(container);
  const isLocalLxd = node.api_type === 'local-lxd';

  if (isLocalLxd) {
    await localLxd.restartContainer(container.name);
  } else {
    await proxmoxApi.rebootLXC(node, container.container_id);
  }

  logLXCAction(id, 'reboot', 'success', `Container ${container.name} rebooted`);
  return { success: true, message: `Container ${container.name} rebooted` };
}

async function deleteContainer(id, userId, isAdmin) {
  const container = await getContainer(id, userId, isAdmin);
  if (!container) throw new Error('Container not found or access denied');

  const node = await getNodeForContainer(container);
  const isLocalLxd = node.api_type === 'local-lxd';

  try {
    if (isLocalLxd) {
      await localLxd.deleteContainer(container.name);
    } else {
      await proxmoxApi.deleteLXC(node, container.container_id);
    }
  } catch (e) {
    // Container may not exist anymore
  }

  db.run(`UPDATE lxc_containers SET status = 'deleted', updated_at = datetime('now') WHERE id = ?`, [id]);
  db.run(`DELETE FROM lxc_logs WHERE container_id = ?`, [id]);

  logLXCAction(id, 'delete', 'success', `Container ${container.name} deleted`);
  return { success: true, message: `Container ${container.name} deleted` };
}

async function cloneContainer(id, data, userId, isAdmin) {
  const container = await getContainer(id, userId, isAdmin);
  if (!container) throw new Error('Container not found or access denied');

  const node = await getNodeForContainer(container);
  const isLocalLxd = node.api_type === 'local-lxd';

  if (isLocalLxd) {
    throw new Error('Clone is not supported for local LXD containers yet');
  }

  const result = await proxmoxApi.cloneLXC(node, container.container_id, {
    hostname: data.hostname || `${container.name}-clone`,
    full: true
  });

  logLXCAction(id, 'clone', 'success', `Container ${container.name} cloned`);
  return { success: true, message: `Container cloned`, data: result };
}

async function rebuildContainer(id, template, userId, isAdmin) {
  const container = await getContainer(id, userId, isAdmin);
  if (!container) throw new Error('Container not found or access denied');

  const node = await getNodeForContainer(container);
  const isLocalLxd = node.api_type === 'local-lxd';

  if (isLocalLxd) {
    // For local LXD, rebuild means delete and recreate
    await localLxd.deleteContainer(container.name);
    const imageMap = {
      'ubuntu_24_lxc': 'images:ubuntu/24.04',
      'ubuntu_22_lxc': 'images:ubuntu/22.04',
      'debian_12_lxc': 'images:debian/12',
      'alpine_lxc': 'images:alpine/edge',
      'centos_9_lxc': 'images:centos/9-Stream'
    };
    const image = imageMap[template || container.template_key] || 'images:ubuntu/24.04';
    await localLxd.createContainer({
      name: container.name,
      image,
      cpu_cores: container.cpu_cores,
      memory: container.memory,
      disk_size: container.disk_size,
      password: container.password,
      network_type: container.network_type
    });
  } else {
    await proxmoxApi.rebuildLXC(node, container.container_id, template || container.template_key);
  }

  db.run(`UPDATE lxc_containers SET status = 'stopped', last_activity = datetime('now'), updated_at = datetime('now') WHERE id = ?`, [id]);
  logLXCAction(id, 'rebuild', 'success', `Container ${container.name} rebuilt with template ${template || container.template_key}`);

  return { success: true, message: `Container rebuilt` };
}

async function migrateContainer(id, targetNodeId, userId, isAdmin) {
  const container = await getContainer(id, userId, isAdmin);
  if (!container) throw new Error('Container not found or access denied');
  if (container.status !== 'stopped') throw new Error('Container must be stopped before migration');

  const sourceNode = await getNodeForContainer(container);
  const isLocalLxd = sourceNode.api_type === 'local-lxd';

  if (isLocalLxd) {
    throw new Error('Migration from local LXD is not supported yet');
  }

  const targetNode = await new Promise((resolve, reject) => {
    db.get(`SELECT * FROM nodes WHERE id = ? AND status != 'deleted'`, [targetNodeId], (err, row) => err ? reject(err) : resolve(row));
  });
  if (!targetNode) throw new Error('Target node not found');

  // Check target node capacity
  const health = await proxmoxApi.getNodeHealth(db, targetNodeId);
  if (health && health.status === 'offline') throw new Error('Target node is offline');

  try {
    await proxmoxApi.apiCall(sourceNode, 'POST', `/nodes/${sourceNode.name}/lxc/${container.container_id}/migrate`, {
      target: targetNode.name,
      online: true
    });
  } catch (err) {
    throw new Error(`Migration failed: ${err.message}`);
  }

  db.run(`UPDATE lxc_containers SET node_id = ?, last_activity = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    [targetNodeId, id]);

  logLXCAction(id, 'migrate', 'success', `Container ${container.name} migrated from ${sourceNode.name} to ${targetNode.name}`);
  return { success: true, message: `Container migrated to ${targetNode.name}` };
}

// ============= Console =============

async function getConsoleInfo(id, userId, isAdmin) {
  const container = await getContainer(id, userId, isAdmin);
  if (!container) throw new Error('Container not found or access denied');
  if (container.status !== 'running') throw new Error('Container must be running');

  const node = await getNodeForContainer(container);
  const isLocalLxd = node.api_type === 'local-lxd';

  if (isLocalLxd) {
    return await localLxd.getConsoleInfo(container.name);
  }
  return await proxmoxApi.openLXCConsole(node, container.container_id);
}

// ============= tmate =============

async function generateTmateSession(id, userId, isAdmin, ipAddress) {
  const container = await getContainer(id, userId, isAdmin);
  if (!container) throw new Error('Container not found or access denied');
  if (container.status !== 'running') throw new Error('Container must be running for tmate');

  const node = await getNodeForContainer(container);

  // Use SSH to connect to the container and generate tmate session
  const { Client } = require('ssh2');
  const conn = new Client();

  const result = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => { conn.end(); reject(new Error('SSH connection timed out')); }, 30000);

    conn.on('ready', () => {
      const script = `
        which tmate >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq tmate 2>/dev/null);
        tmate -S /tmp/tmate.sock new-session -d 'bash -l';
        sleep 2;
        echo "SSH:" $(tmate -S /tmp/tmate.sock display -p '#{tmate-ssh}');
        echo "READONLY:" $(tmate -S /tmp/tmate.sock display -p '#{tmate-ssh-ro}');
        echo "TMATE_COMPLETE"
      `;
      conn.exec(script, (err, stream) => {
        if (err) { clearTimeout(timeout); conn.end(); return reject(err); }
        stream.on('data', (data) => { output += data.toString(); });
        stream.stderr.on('data', () => {});
        stream.on('close', () => {
          clearTimeout(timeout);
          conn.end();
          const sshMatch = output.match(/SSH:\s+(ssh\s+[^\n]+)/);
          const roMatch = output.match(/READONLY:\s+(ssh\s+[^\n]+)/);
          if (output.includes('TMATE_COMPLETE') && sshMatch) {
            resolve({ sshCommand: sshMatch[1].trim(), readonlyCommand: roMatch ? roMatch[1].trim() : null });
          } else {
            reject(new Error('Failed to generate tmate session'));
          }
        });
      });
    });

    conn.on('error', (err) => { clearTimeout(timeout); reject(new Error(`SSH connection failed: ${err.message}`)); });
    conn.connect({
      host: '127.0.0.1', port: node.api_port || 22,
      username: container.username || 'root', password: container.password || '',
      readyTimeout: 15000, tryKeyboard: true,
      algorithms: { serverHostKey: ['ssh-rsa', 'ecdsa-sha2-nistp256', 'ssh-ed25519', 'rsa-sha2-256', 'rsa-sha2-512'] }
    });
    conn.on('keyboard-interactive', (n, i, l, p, f) => f([container.password || '']));
  });

  // Store session record
  const timeout = parseInt(process.env.TMATE_SESSION_TIMEOUT) || 3600;
  const sessionIdentifier = crypto.randomBytes(16).toString('hex');
  const sessionId = await new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO tmate_sessions (vm_id, user_id, session_identifier, ssh_command, readonly_command, status, expires_at)
       VALUES (?, ?, ?, ?, ?, 'active', datetime('now', '+${timeout} seconds'))`,
      [id, userId, sessionIdentifier, result.sshCommand, result.readonlyCommand],
      function(err) { err ? reject(err) : resolve(this.lastID); }
    );
  });

  logLXCAction(id, 'tmate_created', 'success', `tmate session generated for container ${container.name}`);
  return { id: sessionId, sshCommand: result.sshCommand, readonlyCommand: result.readonlyCommand, expires_in: timeout };
}

// ============= Helpers =============

async function getNodeForContainer(container) {
  // For local LXD containers, return a virtual node object
  if (!container.node_id) {
    return { id: 0, name: 'local-lxd', api_type: 'local-lxd', hostname: 'localhost', api_url: '' };
  }
  const node = await new Promise((resolve, reject) => {
    db.get(`SELECT * FROM nodes WHERE id = ?`, [container.node_id], (err, row) => err ? reject(err) : resolve(row));
  });
  if (!node) throw new Error('Node not found for this container');
  return node;
}

function logLXCAction(containerId, action, status, message) {
  db.run(
    `INSERT INTO lxc_logs (container_id, action, status, message) VALUES (?, ?, ?, ?)`,
    [containerId, action, status, message]
  );
  if (auditLog) {
    auditLog.log({
      action: `lxc_${action}`,
      resourceType: 'lxc_container',
      resourceId: String(containerId),
      details: message,
      source: 'panel',
      result: status === 'success' ? 'SUCCESS' : 'FAILURE'
    });
  }
}

function getContainerLogs(containerId, limit = 50) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM lxc_logs WHERE container_id = ? ORDER BY timestamp DESC LIMIT ?`,
      [containerId, limit], (err, rows) => err ? reject(err) : resolve(rows || []));
  });
}

module.exports = {
  init, createContainer, getContainer, listContainers,
  startContainer, stopContainer, restartContainer, shutdownContainer,
  rebootContainer, deleteContainer, cloneContainer, rebuildContainer, migrateContainer,
  getConsoleInfo, generateTmateSession, getContainerLogs, logLXCAction
};
