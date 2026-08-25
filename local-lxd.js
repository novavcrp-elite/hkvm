'use strict';

/**
 * Local LXD Container Management Module for HKVM Panel
 * Uses the LXD REST API via unix socket (not the snap CLI wrapper)
 * Supports Debian/Ubuntu and other images from the images: remote
 */

const http = require('http');
const https = require('https');

const LXD_SOCKET = '/var/snap/lxd/common/lxd/unix.socket';

/**
 * Make a request to the LXD API via unix socket
 */
function lxdApiRequest(method, path, body = null, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const options = {
      socketPath: LXD_SOCKET,
      path: path,
      method: method,
      headers: { 'Content-Type': 'application/json' },
      timeout
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          resolve({ data });
        }
      });
    });

    req.on('error', (err) => reject(new Error(`LXD API error: ${err.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('LXD API timeout')); });

    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

/**
 * Check if LXD is available on the local machine
 */
async function isAvailable() {
  try {
    const result = await lxdApiRequest('GET', '/1.0');
    return result.status_code === 200;
  } catch (e) {
    return false;
  }
}

/**
 * Check if LXD is available synchronously
 */
function isAvailableSync() {
  try {
    const { execSync } = require('child_process');
    execSync('/snap/bin/lxc version', { encoding: 'utf8', timeout: 5000, shell: '/bin/bash' });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Initialize LXD if not already initialized
 */
async function initLXD() {
  try {
    const result = await lxdApiRequest('GET', '/1.0');
    return { initialized: result.status_code === 200 };
  } catch (e) {
    return { initialized: false, error: e.message };
  }
}

/**
 * Ensure the images: remote is added
 */
async function ensureImagesRemote() {
  try {
    const result = await lxdApiRequest('GET', '/1.0/remotes');
    const remotes = result.metadata || {};
    if (remotes['images:']) return true;
  } catch (e) {}

  // Add images remote via CLI (this is a one-time setup)
  try {
    const { execSync } = require('child_process');
    execSync('/snap/bin/lxc remote add images: https://images.linuxcontainers.org --protocol simplestreams 2>/dev/null || true',
      { encoding: 'utf8', timeout: 30000, shell: '/bin/bash' });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Create a container using LXD API
 */
async function createContainer(config) {
  const {
    name,
    image = 'images:ubuntu/24.04',
    cpu_cores = 2,
    memory = '2048MB',
    swap = '2048MB',
    disk_size = '20GB',
    network_type = 'dhcp',
    ipv4_address,
    gateway,
    netmask = '24',
    hostname,
    password = 'password',
    bridge = 'lxdbr0',
    unprivileged = true,
    nesting = true,
    description = ''
  } = config;

  if (!name) throw new Error('Container name is required');

  // Ensure images: remote exists
  await ensureImagesRemote();

  const memMB = parseInt(String(memory).replace(/[^0-9]/g, '')) || 2048;
  const diskGB = parseInt(String(disk_size).replace(/[^0-9]/g, '')) || 20;

  // Build LXD instance create request
  const instanceConfig = {
    name: name,
    source: {
      type: 'image',
      alias: image.replace('images:', '')
    },
    devices: {
      root: {
        type: 'disk',
        path: '/',
        pool: 'default',
        size: `${diskGB}GB`
      }
    },
    config: {
      'limits.cpu': String(cpu_cores),
      'limits.memory': `${memMB}MB`,
      'security.nesting': nesting ? 'true' : 'false',
      'security.privileged': unprivileged ? 'false' : 'true'
    },
    profiles: ['default']
  };

  // Network config
  if (network_type === 'static' && ipv4_address) {
    const cidr = netmask.includes('.') ? netmaskToCIDR(netmask) : netmask;
    instanceConfig.devices.eth0 = {
      type: 'nic',
      nictype: 'bridged',
      parent: bridge,
      'ipv4.address': `${ipv4_address}/${cidr}`
    };
  }

  // Cloud-init: set password
  instanceConfig.config['user.user-data'] = `#cloud-config\nchpasswd:\n  expire: false\n  list:\n    - root:${password}\npassword: ${password}\nssh_pwauth: true\nmanage_etc_hosts: true\n`;

  // Create the instance
  const result = await lxdApiRequest('POST', '/1.0/instances', instanceConfig, 120000);
  if (result.type === 'error') {
    throw new Error(`Failed to create container: ${result.error || 'Unknown error'}`);
  }

  // Wait for creation to complete (operation)
  if (result.operation) {
    await waitForOperation(result.operation);
  }

  // Start the container
  try {
    await lxdApiRequest('PUT', `/1.0/instances/${name}/state`, { action: 'start' }, 30000);
  } catch (e) {
    console.warn(`[LocalLXD] Container created but failed to start: ${e.message}`);
  }

  // Get container info
  const info = await getContainerInfo(name);

  return {
    name,
    status: 'running',
    cpu_cores,
    memory: memMB,
    disk_size: `${diskGB}GB`,
    ipv4_address: info?.ipv4_address || 'auto',
    ...info
  };
}

/**
 * Wait for an LXD operation to complete
 */
async function waitForOperation(operationPath, timeout = 120000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    try {
      const result = await lxdApiRequest('GET', operationPath);
      if (result.metadata?.status === 'Success' || result.status_code === 200) {
        return result;
      }
      if (result.metadata?.status === 'Failure') {
        throw new Error(result.metadata?.err || 'Operation failed');
      }
    } catch (e) {
      if (e.message.includes('not found')) break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

/**
 * Start a container
 */
async function startContainer(name) {
  const result = await lxdApiRequest('PUT', `/1.0/instances/${name}/state`, { action: 'start' }, 30000);
  if (result.type === 'error') throw new Error(`Failed to start container: ${result.error}`);
  if (result.operation) await waitForOperation(result.operation);
  return { success: true, message: `Container ${name} started` };
}

/**
 * Stop a container
 */
async function stopContainer(name) {
  const result = await lxdApiRequest('PUT', `/1.0/instances/${name}/state`, { action: 'stop', force: true }, 60000);
  if (result.type === 'error') throw new Error(`Failed to stop container: ${result.error}`);
  if (result.operation) await waitForOperation(result.operation);
  return { success: true, message: `Container ${name} stopped` };
}

/**
 * Restart a container
 */
async function restartContainer(name) {
  const result = await lxdApiRequest('PUT', `/1.0/instances/${name}/state`, { action: 'restart' }, 60000);
  if (result.type === 'error') throw new Error(`Failed to restart container: ${result.error}`);
  if (result.operation) await waitForOperation(result.operation);
  return { success: true, message: `Container ${name} restarted` };
}

/**
 * Shutdown a container gracefully
 */
async function shutdownContainer(name) {
  const result = await lxdApiRequest('PUT', `/1.0/instances/${name}/state`, { action: 'stop', timeout: 30 }, 60000);
  if (result.type === 'error') throw new Error(`Failed to shutdown container: ${result.error}`);
  if (result.operation) await waitForOperation(result.operation);
  return { success: true, message: `Container ${name} shut down` };
}

/**
 * Delete a container
 */
async function deleteContainer(name) {
  // Stop first if running
  try { await stopContainer(name); } catch (e) {}
  const result = await lxdApiRequest('DELETE', `/1.0/instances/${name}?force=1`, null, 60000);
  if (result.type === 'error') throw new Error(`Failed to delete container: ${result.error}`);
  if (result.operation) await waitForOperation(result.operation);
  return { success: true, message: `Container ${name} deleted` };
}

/**
 * Get container info
 */
async function getContainerInfo(name) {
  try {
    const result = await lxdApiRequest('GET', `/1.0/instances/${name}?recursion=1`, null, 10000);
    if (result.type === 'error' || !result.metadata) return null;

    const info = result.metadata;

    // Extract IP address
    let ipv4 = null;
    const eth0 = info.state?.network?.eth0;
    if (eth0) {
      const ipv4Info = eth0.addresses?.find(a => a.family === 'inet');
      if (ipv4Info) ipv4 = ipv4Info.address;
    }

    return {
      name: info.name,
      status: info.status,
      cpu_cores: info.config?.['limits.cpu'] ? parseInt(info.config['limits.cpu']) : 2,
      memory: info.config?.['limits.memory'] ? parseInt(info.config['limits.memory']) : 2048,
      disk_size: info.devices?.root?.size || '20GB',
      ipv4_address: ipv4,
      pid: info.state?.pid,
      uptime: info.state?.started_at ? Math.floor(Date.now() / 1000) - info.state.started_at : 0,
      architecture: info.architecture,
      os: info.config?.['image.os'] || 'unknown',
      description: info.description || ''
    };
  } catch (e) {
    console.error(`[LocalLXD] Failed to get container info for ${name}:`, e.message);
    return null;
  }
}

/**
 * List all containers
 */
async function listContainers() {
  try {
    const result = await lxdApiRequest('GET', '/1.0/instances?recursion=1', null, 10000);
    if (result.type === 'error' || !result.metadata) return [];

    const instances = Array.isArray(result.metadata) ? result.metadata : [];
    return instances.map(c => ({
      name: c.name,
      status: c.status,
      description: c.description || ''
    }));
  } catch (e) {
    console.error('[LocalLXD] Failed to list containers:', e.message);
    return [];
  }
}

/**
 * Get container console info
 */
async function getConsoleInfo(name) {
  const info = await getContainerInfo(name);
  if (!info || info.status !== 'Running') {
    throw new Error('Container must be running to access console');
  }

  return {
    name,
    status: info.status,
    message: `Container ${name} is running. Use SSH or 'lxc exec ${name} bash' for console access.`
  };
}

/**
 * Execute a command inside a container
 */
async function execInContainer(name, command) {
  try {
    const result = await lxdApiRequest('POST', `/1.0/instances/${name}/exec`, {
      command: ['/bin/sh', '-c', command],
      interactive: false
    }, 30000);

    if (result.operation) {
      const opResult = await waitForOperation(result.operation);
      return { stdout: opResult?.metadata?.output || '', stderr: '', success: true };
    }
    return { stdout: '', stderr: result.error || '', success: !result.error };
  } catch (e) {
    return { stdout: '', stderr: e.message, success: false };
  }
}

/**
 * Get LXD server info
 */
async function getServerInfo() {
  try {
    const result = await lxdApiRequest('GET', '/1.0', null, 10000);
    return result.type === 'error' ? null : (result.metadata || result);
  } catch (e) {
    return null;
  }
}

/**
 * List available images from the images: remote
 */
async function listImages() {
  try {
    const result = await lxdApiRequest('GET', '/1.0/images?recursion=1', null, 30000);
    if (result.type === 'error' || !result.metadata) return [];

    const images = Array.isArray(result.metadata) ? result.metadata : [];
    return images.map(img => ({
      alias: img.aliases?.[0]?.name || img.fingerprint?.substring(0, 12),
      description: img.description || img.properties?.description || '',
      os: img.properties?.os || 'unknown',
      release: img.properties?.release || '',
      architecture: img.architecture,
      size: img.size
    }));
  } catch (e) {
    return [];
  }
}

/**
 * Convert netmask to CIDR notation
 */
function netmaskToCIDR(mask) {
  if (!mask || mask.includes('/') || !mask.includes('.')) return mask || '24';
  const parts = mask.split('.');
  let bits = 0;
  for (let i = 0; i < 4; i++) {
    const octet = parseInt(parts[i]);
    for (let j = 7; j >= 0; j--) {
      bits += (octet >> j) & 1;
    }
  }
  return String(bits);
}

module.exports = {
  isAvailable,
  isAvailableSync,
  initLXD,
  ensureImagesRemote,
  createContainer,
  startContainer,
  stopContainer,
  restartContainer,
  shutdownContainer,
  deleteContainer,
  getContainerInfo,
  listContainers,
  getConsoleInfo,
  execInContainer,
  getServerInfo,
  listImages,
  netmaskToCIDR
};
