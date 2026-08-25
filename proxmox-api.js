'use strict';

/**
 * Proxmox VE API Client
 * Handles communication with Proxmox VE nodes for LXC and VM management
 * Credentials are stored encrypted in the database, never exposed to frontend
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const HTTP_TIMEOUT = 15000;

/**
 * Make an authenticated API call to a Proxmox node
 * @param {Object} node - Node record from database
 * @param {string} method - HTTP method (GET, POST, PUT, DELETE)
 * @param {string} path - API path (e.g., '/nodes/pve1/lxc')
 * @param {Object} data - Request body for POST/PUT
 * @returns {Promise<Object>} API response
 */
async function apiCall(node, method, path, data = null) {
  const baseUrl = node.api_url;
  const token = node.api_token;

  if (!baseUrl || !token) {
    throw new Error('Node API URL or token not configured');
  }

  const url = new URL(path, baseUrl);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: url.hostname,
      port: url.port || 8006,
      path: url.pathname + url.search,
      method: method.toUpperCase(),
      headers: {
        'Authorization': `PVEAPIToken=${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: HTTP_TIMEOUT,
      // Allow self-signed certs
      rejectUnauthorized: false
    };

    const reqModule = url.protocol === 'https:' ? https : http;

    const req = reqModule.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject(new Error(json.errors?.[0]?.msg || `API error ${res.statusCode}: ${body.substring(0, 200)}`));
          }
        } catch (e) {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ data: body });
          } else {
            reject(new Error(`API response parse error: ${body.substring(0, 200)}`));
          }
        }
      });
    });

    req.on('error', (err) => reject(new Error(`API connection failed: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('API request timed out')); });

    if (data && (method === 'POST' || method === 'PUT')) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

/**
 * Test connection to a Proxmox node
 * @param {Object} node - Node record
 * @returns {Promise<Object>} { success, version, nodes }
 */
async function testConnection(node) {
  try {
    const versionRes = await apiCall(node, 'GET', '/version');
    const nodesRes = await apiCall(node, 'GET', '/nodes');
    return {
      success: true,
      version: versionRes.data?.version || 'unknown',
      nodes: nodesRes.data || []
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Get node status and resources from Proxmox
 * @param {Object} node - Node record
 * @returns {Promise<Object>} { status, cpu, memory, disk, vms, containers }
 */
async function getNodeStatus(node) {
  const statusRes = await apiCall(node, 'GET', `/nodes/${node.name}/status`);
  const data = statusRes.data || {};

  // Get resource list for counting
  const resourcesRes = await apiCall(node, 'GET', '/cluster/resources');
  const resources = resourcesRes.data || [];

  const nodeResources = resources.filter(r => r.node === node.name);

  return {
    status: data.status || 'unknown',
    cpu: data.cpu || 0,
    cpu_cores: data.maxcpu || 0,
    memory_used: data.mem || 0,
    memory_total: data.maxmem || 0,
    memory_pct: data.maxmem ? Math.round((data.mem / data.maxmem) * 100) : 0,
    disk_used: data.disk || 0,
    disk_total: data.maxdisk || 0,
    disk_pct: data.maxdisk ? Math.round((data.disk / data.maxdisk) * 100) : 0,
    uptime: data.uptime || 0,
    running_vms: nodeResources.filter(r => r.type === 'qemu' && r.status === 'running').length,
    running_cts: nodeResources.filter(r => r.type === 'lxc' && r.status === 'running').length,
    total_vms: nodeResources.filter(r => r.type === 'qemu').length,
    total_cts: nodeResources.filter(r => r.type === 'lxc').length
  };
}

// ============= LXC Operations =============

/**
 * Create an LXC container on a Proxmox node
 */
async function createLXC(node, config) {
  const path = `/nodes/${node.name}/lxc`;

  const lxcConfig = {
    ostemplate: config.template || 'local:vztmpl/ubuntu-24.04-standard_24.04.2-1_amd64.tar.zst',
    vmid: config.vmid || 0, // 0 = auto-assign
    hostname: config.hostname || config.name,
    memory: config.memory || 2048,
    swap: config.swap || config.memory || 2048,
    cores: config.cores || 2,
    rootfs: `local-lvm:vm-${config.vmid || 0}-rootfs,size=${config.disk_size || '20G'}`,
    net0: `name=eth0,bridge=${config.bridge || 'vmbr0'},ip=${config.ipv4_address ? config.ipv4_address + '/' + (config.netmask || '24') : 'dhcp'}${config.ipv6_address ? ',ip6=' + config.ipv6_address + '/' + (config.ipv6_mask || '64') : ',ip6=dhcp'}`,
    password: config.password || 'password',
    unprivileged: config.unprivileged !== false ? 1 : 0,
    features: config.features || 'nesting=1',
    onboot: config.onboot ? 1 : 0,
    ostype: config.ostype || 'ubuntu'
  };

  // Remove undefined values
  Object.keys(lxcConfig).forEach(key => {
    if (lxcConfig[key] === undefined || lxcConfig[key] === null) delete lxcConfig[key];
  });

  const result = await apiCall(node, 'POST', path, lxcConfig);
  return {
    vmid: result.data?.upid ? parseInt(result.data.upid.split('/')[1]) : config.vmid,
    upid: result.data?.upid
  };
}

/**
 * Start an LXC container
 */
async function startLXC(node, vmid) {
  return apiCall(node, 'POST', `/nodes/${node.name}/lxc/${vmid}/status/start`);
}

/**
 * Stop an LXC container
 */
async function stopLXC(node, vmid) {
  return apiCall(node, 'POST', `/nodes/${node.name}/lxc/${vmid}/status/stop`);
}

/**
 * Restart an LXC container
 */
async function restartLXC(node, vmid) {
  return apiCall(node, 'POST', `/nodes/${node.name}/lxc/${vmid}/status/restart`);
}

/**
 * Shutdown an LXC container (graceful)
 */
async function shutdownLXC(node, vmid) {
  return apiCall(node, 'POST', `/nodes/${node.name}/lxc/${vmid}/status/shutdown`);
}

/**
 * Reboot an LXC container (graceful)
 */
async function rebootLXC(node, vmid) {
  return apiCall(node, 'POST', `/nodes/${node.name}/lxc/${vmid}/status/reboot`);
}

/**
 * Delete an LXC container
 */
async function deleteLXC(node, vmid) {
  return apiCall(node, 'DELETE', `/nodes/${node.name}/lxc/${vmid}`);
}

/**
 * Clone an LXC container
 */
async function cloneLXC(node, vmid, config) {
  const path = `/nodes/${node.name}/lxc/${vmid}/clone`;
  return apiCall(node, 'POST', path, {
    newid: config.newid || 0,
    hostname: config.hostname || undefined,
    full: config.full !== false ? 1 : 0
  });
}

/**
 * Rebuild an LXC container (reinstall OS)
 */
async function rebuildLXC(node, vmid, template) {
  const path = `/nodes/${node.name}/lxc/${vmid}/template`;
  return apiCall(node, 'POST', path, {
    ostemplate: template || undefined
  });
}

/**
 * Get LXC container status
 */
async function getLXCStatus(node, vmid) {
  const result = await apiCall(node, 'GET', `/nodes/${node.name}/lxc/${vmid}/status/current`);
  return result.data || {};
}

/**
 * Get LXC container config
 */
async function getLXCConfig(node, vmid) {
  const result = await apiCall(node, 'GET', `/nodes/${node.name}/lxc/${vmid}/config`);
  return result.data || {};
}

/**
 * Open LXC console (noVnc or tty)
 */
async function openLXCConsole(node, vmid) {
  // Proxmox LXC console via websocket
  // Returns the websocket URL for the client to connect to
  const result = await apiCall(node, 'GET', `/nodes/${node.name}/lxc/${vmid}/status/current`);
  if (result.data?.status !== 'running') {
    throw new Error('Container must be running to open console');
  }
  return {
    url: `${node.api_url}/nodes/${node.name}/lxc/${vmid}/console`,
    node: node.name,
    vmid
  };
}

/**
 * List LXC templates on a node
 */
async function listLXCTemplates(node) {
  const result = await apiCall(node, 'GET', `/nodes/${node.name}/storage/local/content`);
  const items = result.data || [];
  return items.filter(item => item.content?.includes('vztmpl')).map(item => ({
    id: item.volid,
    filename: item.volid.split('/').pop(),
    size: item.size,
    format: item.format
  }));
}

/**
 * Get available nodes for a user (respects restrictions)
 */
async function getAvailableNodes(db, userId) {
  return new Promise((resolve, reject) => {
    db.all(`
      SELECT n.* FROM nodes n
      WHERE n.status != 'deleted' AND n.enabled = 1
      AND (n.id NOT IN (
        SELECT nr.node_id FROM node_restrictions nr
        WHERE nr.restriction_type = 'user' AND nr.user_id = ?
      ) OR NOT EXISTS (
        SELECT 1 FROM node_restrictions nr
        WHERE nr.restriction_type = 'user' AND nr.node_id = n.id
      ))
      ORDER BY n.priority ASC, n.name ASC
    `, [userId], (err, rows) => err ? reject(err) : resolve(rows || []));
  });
}

/**
 * Auto-select the best node based on resource availability
 */
async function autoSelectNode(db, userId, requirements = {}) {
  const nodes = await getAvailableNodes(db, userId);

  if (nodes.length === 0) throw new Error('No available nodes for this user');

  // Score each node
  let bestNode = null;
  let bestScore = -1;

  for (const node of nodes) {
    if (node.status === 'maintenance' || node.status === 'offline') continue;

    try {
      const health = await getNodeHealth(db, node.id);
      if (!health) continue;

      let score = 100;

      // Penalize based on resource usage
      score -= (health.cpu_pct || 0) * 0.3;
      score -= (health.memory_pct || 0) * 0.3;
      score -= (health.disk_pct || 0) * 0.2;

      // Bonus for node priority (lower = higher priority)
      score += (10 - (node.priority || 5)) * 2;

      // Check minimum requirements
      if (requirements.memory) {
        const freeMem = (health.memory_total - health.memory_used) / (1024 * 1024);
        if (freeMem < requirements.memory) continue;
      }
      if (requirements.disk) {
        const freeDisk = (health.disk_total - health.disk_used) / (1024 * 1024 * 1024);
        if (freeDisk < requirements.disk) continue;
      }

      if (score > bestScore) {
        bestScore = score;
        bestNode = node;
      }
    } catch (e) {
      continue;
    }
  }

  if (!bestNode) throw new Error('No node has sufficient resources');

  return bestNode;
}

/**
 * Get node health from database (cached)
 */
async function getNodeHealth(db, nodeId) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM node_health WHERE node_id = ? ORDER BY checked_at DESC LIMIT 1`,
      [nodeId], (err, row) => err ? reject(err) : resolve(row));
  });
}

module.exports = {
  apiCall, testConnection, getNodeStatus,
  createLXC, startLXC, stopLXC, restartLXC, shutdownLXC, rebootLXC,
  deleteLXC, cloneLXC, rebuildLXC, getLXCStatus, getLXCConfig,
  openLXCConsole, listLXCTemplates,
  getAvailableNodes, autoSelectNode, getNodeHealth
};
