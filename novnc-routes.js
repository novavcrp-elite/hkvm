'use strict';

/**
 * NoVNC Web Console Module for HKVM Panel
 * Provides WebSocket-based VNC proxying with token authentication
 */

const crypto = require('crypto');
const net = require('net');
const { WebSocket, WebSocketServer } = require('ws');

let db = null;
let auditLog = null;
const vncTokens = new Map(); // token -> { vmId, userId, expiresAt, createdAt }

// VNC session timeout: 30 minutes
const VNC_SESSION_TIMEOUT = 30 * 60 * 1000;

function init(database, audit) {
  db = database;
  auditLog = audit;

  // Create novnc_sessions table
  db.run(`CREATE TABLE IF NOT EXISTS novnc_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vm_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    vnc_port INTEGER,
    status TEXT DEFAULT 'active',
    expires_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    closed_at DATETIME,
    FOREIGN KEY(vm_id) REFERENCES vms(vm_id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  // Clean up expired tokens periodically
  setInterval(cleanExpiredTokens, 60000);
  console.log('[NoVNC] NoVNC console module initialized');
}

function cleanExpiredTokens() {
  const now = Date.now();
  for (const [token, data] of vncTokens.entries()) {
    if (data.expiresAt < now) {
      vncTokens.delete(token);
    }
  }
}

/**
 * Generate a short-lived VNC access token
 */
async function generateToken(vm, userId, ipAddress) {
  if (!vm) throw new Error('VM not found');
  if (vm.status !== 'running') throw new Error('VM must be running for console access');
  if (vm.owner_id && vm.owner_id !== userId && !vm.owner_id) {
    // Allow if owner_id is null (unassigned VM) or matches
  } else if (vm.owner_id && vm.owner_id !== userId) {
    throw new Error('Access denied: you do not own this VM');
  }

  const token = crypto.randomBytes(32).toString('hex');
  const vncPort = 5900 + parseInt(vm.vm_id);
  const expiresAt = Date.now() + VNC_SESSION_TIMEOUT;

  // Store token in memory (never persisted with secrets)
  vncTokens.set(token, {
    vmId: parseInt(vm.vm_id),
    userId,
    vncPort,
    expiresAt,
    createdAt: Date.now()
  });

  // Store session record (without the actual token secret)
  const sessionTokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO novnc_sessions (vm_id, user_id, token, vnc_port, status, expires_at)
       VALUES (?, ?, ?, ?, 'active', datetime('now', '+30 minutes'))`,
      [vm.vm_id, userId, sessionTokenHash],
      (err) => err ? reject(err) : resolve()
    );
  });

  if (auditLog) {
    auditLog.log({
      userId,
      action: 'novnc_session_created',
      resourceType: 'vm',
      resourceId: String(vm.vm_id),
      details: `NoVNC session created for VM ${vm.vm_name} (ID: ${vm.vm_id}), port ${vncPort}`,
      ipAddress,
      source: 'panel',
      result: 'SUCCESS'
    });
  }

  return {
    success: true,
    token,
    vncPort,
    wsUrl: `ws://${ipAddress || 'localhost'}:${process.env.PORT || 8080}/novnc/ws?token=${token}`,
    expiresAt: new Date(expiresAt).toISOString()
  };
}

/**
 * Validate a VNC token
 */
function validateToken(token) {
  const data = vncTokens.get(token);
  if (!data) return null;
  if (data.expiresAt < Date.now()) {
    vncTokens.delete(token);
    return null;
  }
  return data;
}

/**
 * Revoke a VNC token
 */
function revokeToken(token, userId, ipAddress) {
  const data = vncTokens.get(token);
  if (!data) throw new Error('Session not found or already expired');
  if (data.userId !== userId) throw new Error('Access denied');

  vncTokens.delete(token);

  if (auditLog) {
    auditLog.log({
      userId,
      action: 'novnc_session_revoked',
      resourceType: 'vm',
      resourceId: String(data.vmId),
      details: `NoVNC session revoked for VM ID ${data.vmId}`,
      ipAddress,
      source: 'panel',
      result: 'SUCCESS'
    });
  }

  return { success: true };
}

/**
 * Setup WebSocket proxy for VNC connections
 * Call this once with the WebSocket server instance
 */
function setupWebSocketProxy(wss) {
  // Create a separate path handler for NoVNC
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== '/novnc/ws') return;

    const token = url.searchParams.get('token');
    if (!token) {
      ws.send(JSON.stringify({ type: 'error', message: 'Missing token' }));
      ws.close();
      return;
    }

    const sessionData = validateToken(token);
    if (!sessionData) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid or expired token' }));
      ws.close();
      return;
    }

    const { vncPort, vmId } = sessionData;

    // Create TCP connection to QEMU VNC
    const vncSocket = net.createConnection({ port: vncPort, host: '127.0.0.1' }, () => {
      ws.send(JSON.stringify({ type: 'connected', vmId }));
    });

    // Proxy data: VNC TCP <-> WebSocket
    vncSocket.on('data', (data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data, { binary: true });
      }
    });

    vncSocket.on('error', (err) => {
      console.error(`[NoVNC] VNC socket error for VM ${vmId}:`, err.message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: `VNC connection failed: ${err.message}` }));
        ws.close();
      }
    });

    vncSocket.on('close', () => {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    });

    ws.on('message', (data) => {
      if (vncSocket.writable) vncSocket.write(data);
    });

    ws.on('close', () => {
      vncSocket.destroy();
    });

    ws.on('error', () => {
      vncSocket.destroy();
    });
  });
}

module.exports = { init, generateToken, validateToken, revokeToken, setupWebSocketProxy };
