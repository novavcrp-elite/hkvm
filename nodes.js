'use strict';

/**
 * Node Management Module for HKVM Panel
 * Handles Proxmox node CRUD, health monitoring, scheduling, and restrictions
 */

const proxmoxApi = require('./proxmox-api');
const localLxd = require('./local-lxd');

let db = null;
let auditLog = null;

// Health check interval: 60 seconds
const HEALTH_CHECK_INTERVAL = 60000;
let healthCheckTimer = null;

function init(database, audit) {
  db = database;
  auditLog = audit;
  console.log('[Nodes] Node management initialized');
}

// ============= Database Operations =============

function createNode(data, callback) {
  const { name, hostname, api_url, api_token, api_type, location, priority, description, enabled } = data;

  if (!name || !hostname || !api_url || !api_token) {
    return callback(new Error('name, hostname, api_url, and api_token are required'));
  }

  db.run(
    `INSERT INTO nodes (name, hostname, api_url, api_token, api_type, location, priority, description, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, hostname, api_url, api_token, api_type || 'proxmox', location || '', priority || 5, description || '', enabled !== false ? 1 : 0],
    function(err) {
      if (err) return callback(err);
      callback(null, { id: this.lastID, name });
    }
  );
}

function updateNode(id, data, callback) {
  const updates = [];
  const values = [];

  const fields = ['name', 'hostname', 'api_url', 'api_token', 'api_type', 'location', 'priority', 'description', 'enabled', 'status'];
  fields.forEach(field => {
    if (data[field] !== undefined) {
      updates.push(`${field} = ?`);
      values.push(data[field]);
    }
  });

  if (updates.length === 0) return callback(new Error('No fields to update'));

  updates.push("updated_at = datetime('now')");
  values.push(id);

  db.run(`UPDATE nodes SET ${updates.join(', ')} WHERE id = ?`, values, callback);
}

function deleteNode(id, callback) {
  // Check if node has active resources
  db.get(`SELECT COUNT(*) as count FROM lxc_containers WHERE node_id = ? AND status != 'deleted'`, [id], (err, row) => {
    if (err) return callback(err);
    if (row && row.count > 0) {
      return callback(new Error(`Node has ${row.count} active containers. Remove them first.`));
    }

    db.get(`SELECT COUNT(*) as count FROM vms WHERE node_id = ? AND status != 'stopped'`, [id], (err2, row2) => {
      if (err2) return callback(err2);
      if (row2 && row2.count > 0) {
        return callback(new Error(`Node has ${row2.count} running VMs. Stop them first.`));
      }

      db.run(`UPDATE nodes SET status = 'deleted', enabled = 0 WHERE id = ?`, [id], callback);
    });
  });
}

function getNode(id, callback) {
  db.get(`SELECT * FROM nodes WHERE id = ? AND status != 'deleted'`, [id], callback);
}

function getNodeByName(name, callback) {
  db.get(`SELECT * FROM nodes WHERE name = ? AND status != 'deleted'`, [name], callback);
}

function listNodes(callback) {
  db.all(`SELECT * FROM nodes WHERE status != 'deleted' ORDER BY priority ASC, name ASC`, [], callback);
}

// ============= Health Monitoring =============

async function checkNodeHealth(node) {
  try {
    let status;

    // Handle local LXD nodes differently
    if (node.api_type === 'local-lxd') {
      const available = await localLxd.isAvailable();
      if (!available) throw new Error('Local LXD not available');

      // Get LXD server info and host system info
      const serverInfo = await localLxd.getServerInfo();
      const containers = await localLxd.listContainers();
      const running = containers.filter(c => c.status === 'Running' || c.status === 'running');

      // Get host system resources
      const os = require('os');
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const cpus = os.cpus();
      const cpuUsage = cpus.reduce((sum, cpu) => {
        const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
        return sum + (cpu.times.user + cpu.times.nice + cpu.times.sys); // busy time
      }, 0) / (cpus.length * 1000); // normalize

      // Get disk usage
      let diskUsed = 0, diskTotal = 0;
      try {
        const { execSync } = require('child_process');
        const dfOutput = execSync("df / --output=used,size -B1 2>/dev/null | tail -1", { encoding: 'utf8' }).trim();
        const [used, total] = dfOutput.split(/\s+/).map(Number);
        diskUsed = used || 0;
        diskTotal = total || 0;
      } catch (e) {}

      status = {
        status: 'online',
        cpu: cpuUsage,
        cpu_cores: cpus.length,
        memory_used: usedMem,
        memory_total: totalMem,
        memory_pct: Math.round((usedMem / totalMem) * 100),
        disk_used: diskUsed,
        disk_total: diskTotal,
        disk_pct: diskTotal ? Math.round((diskUsed / diskTotal) * 100) : 0,
        uptime: os.uptime(),
        running_vms: 0,
        running_cts: running.length,
        total_vms: 0,
        total_cts: containers.length
      };
    } else {
      // Proxmox node - use API
      status = await proxmoxApi.getNodeStatus(node);
    }

    const healthData = {
      node_id: node.id,
      status: status.status === 'online' ? 'online' : 'offline',
      cpu_pct: Math.round(status.cpu * 100),
      cpu_cores: status.cpu_cores,
      memory_used: status.memory_used,
      memory_total: status.memory_total,
      memory_pct: status.memory_pct,
      disk_used: status.disk_used,
      disk_total: status.disk_total,
      disk_pct: status.disk_pct,
      uptime: status.uptime,
      running_vms: status.running_vms,
      running_cts: status.running_cts,
      total_vms: status.total_vms,
      total_cts: status.total_cts
    };

    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO node_health (node_id, status, cpu_pct, cpu_cores, memory_used, memory_total, memory_pct,
         disk_used, disk_total, disk_pct, uptime, running_vms, running_cts, total_vms, total_cts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [healthData.node_id, healthData.status, healthData.cpu_pct, healthData.cpu_cores,
         healthData.memory_used, healthData.memory_total, healthData.memory_pct,
         healthData.disk_used, healthData.disk_total, healthData.disk_pct,
         healthData.uptime, healthData.running_vms, healthData.running_cts,
         healthData.total_vms, healthData.total_cts],
        (err) => err ? reject(err) : resolve()
      );
    });

    // Update node status
    db.run(`UPDATE nodes SET status = ?, last_health_check = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      [healthData.status, node.id]);

    return healthData;
  } catch (err) {
    console.error(`[Nodes] Health check failed for ${node.name}:`, err.message);
    db.run(`UPDATE nodes SET status = 'offline', last_health_check = datetime('now') WHERE id = ?`, [node.id]);
    return { status: 'offline', error: err.message };
  }
}

async function checkAllNodes() {
  try {
    const nodes = await new Promise((resolve, reject) => {
      db.all(`SELECT * FROM nodes WHERE status != 'deleted' AND enabled = 1`, [], (err, rows) =>
        err ? reject(err) : resolve(rows || []));
    });

    for (const node of nodes) {
      await checkNodeHealth(node);
    }
  } catch (err) {
    console.error('[Nodes] Health check batch error:', err.message);
  }
}

function startHealthChecks() {
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  healthCheckTimer = setInterval(checkAllNodes, HEALTH_CHECK_INTERVAL);
  // Run first check after 5 seconds
  setTimeout(checkAllNodes, 5000);
  console.log('[Nodes] Health checks started (every 60s)');
}

function stopHealthChecks() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

// ============= Node Restrictions =============

function setNodeRestriction(nodeId, restrictionType, userId, planId, templateKey, callback) {
  db.run(
    `INSERT OR REPLACE INTO node_restrictions (node_id, restriction_type, user_id, plan_id, template_key)
     VALUES (?, ?, ?, ?, ?)`,
    [nodeId, restrictionType, userId || null, planId || null, templateKey || null],
    callback
  );
}

function removeNodeRestriction(nodeId, restrictionType, userId, callback) {
  let query = 'DELETE FROM node_restrictions WHERE node_id = ? AND restriction_type = ?';
  const params = [nodeId, restrictionType];
  if (userId) {
    query += ' AND user_id = ?';
    params.push(userId);
  }
  db.run(query, params, callback);
}

function getNodeRestrictions(nodeId, callback) {
  db.all(`SELECT * FROM node_restrictions WHERE node_id = ?`, [nodeId], callback);
}

function getUserAllowedNodes(userId, callback) {
  db.all(`
    SELECT n.* FROM nodes n
    WHERE n.status != 'deleted' AND n.enabled = 1
    AND (NOT EXISTS (
      SELECT 1 FROM node_restrictions nr
      WHERE nr.node_id = n.id AND nr.restriction_type = 'user'
    ) OR EXISTS (
      SELECT 1 FROM node_restrictions nr
      WHERE nr.node_id = n.id AND nr.restriction_type = 'user' AND nr.user_id = ?
    ))
    ORDER BY n.priority ASC
  `, [userId], callback);
}

module.exports = {
  init, createNode, updateNode, deleteNode, getNode, getNodeByName, listNodes,
  checkNodeHealth, checkAllNodes, startHealthChecks, stopHealthChecks,
  setNodeRestriction, removeNodeRestriction, getNodeRestrictions, getUserAllowedNodes
};
