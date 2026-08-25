'use strict';

/**
 * tmate Session Management for HKVM Panel
 * Generates tmate SSH sessions for remote access to VMs
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const path = require('path');
const fs = require('fs');

let db = null;
let auditLog = null;

// Rate limiting: userId -> last request timestamp
const rateLimits = new Map();
const RATE_LIMIT_MS = 10000; // 10 seconds between requests

function init(database, audit) {
  db = database;
  auditLog = audit;

  // Create tmate_sessions table
  db.run(`CREATE TABLE IF NOT EXISTS tmate_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vm_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    session_identifier TEXT,
    ssh_command TEXT,
    readonly_command TEXT,
    status TEXT DEFAULT 'pending',
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    revoked_at DATETIME,
    FOREIGN KEY(vm_id) REFERENCES vms(vm_id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  console.log('[tmate] tmate session management initialized');
}

/**
 * Check rate limit for a user
 */
function checkRateLimit(userId) {
  const now = Date.now();
  const lastRequest = rateLimits.get(userId);
  if (lastRequest && (now - lastRequest) < RATE_LIMIT_MS) {
    return false;
  }
  rateLimits.set(userId, now);
  return true;
}

/**
 * Generate a tmate session for a VM
 * Connects to the VM via SSH, installs tmate if needed, and generates a session
 */
async function generateSession(vm, userId, ipAddress) {
  // Rate limiting
  if (!checkRateLimit(userId)) {
    throw new Error('Rate limit exceeded. Please wait before generating another session.');
  }

  // Validate VM
  if (!vm) throw new Error('VM not found');
  if (vm.status !== 'running') throw new Error('VM must be running to generate a tmate session');
  if (vm.owner_id && vm.owner_id !== userId) throw new Error('Access denied: you do not own this VM');

  // Check for existing active session
  const existingSession = await new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM tmate_sessions WHERE vm_id = ? AND user_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > datetime('now'))`,
      [vm.vm_id, userId],
      (err, row) => err ? reject(err) : resolve(row)
    );
  });

  if (existingSession) {
    return {
      success: true,
      session: existingSession,
      message: 'Active session already exists'
    };
  }

  const timeout = parseInt(process.env.TMATE_SESSION_TIMEOUT) || 3600;

  // Build SSH connection details from VM
  const sshPort = vm.ssh_port || vm.ssh_port_static || 22;
  const username = vm.username || 'root';
  const password = vm.password || '';

  // Create session record
  const sessionId = await new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO tmate_sessions (vm_id, user_id, status, expires_at) VALUES (?, ?, 'pending', datetime('now', '+${timeout} seconds'))`,
      [vm.vm_id, userId],
      function(err) { err ? reject(err) : resolve(this.lastID); }
    );
  });

  try {
    // Build the tmate command to execute inside the VM via SSH
    // We use sshpass or expect-like approach for password-based SSH
    const escapedPassword = password.replace(/'/g, "'\\''");

    // Script to run inside the VM: install tmate if needed, then create session
    const innerScript = `
      which tmate >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq tmate 2>/dev/null) || (yum install -y epel-release 2>/dev/null && yum install -y tmate 2>/dev/null) || (pacman -S --noconfirm tmate 2>/dev/null);
      tmate -S /tmp/tmate.sock new-session -d 'bash -l';
      sleep 2;
      echo "SSH:" $(tmate -S /tmp/tmate.sock display -p '#{tmate-ssh}');
      echo "READONLY:" $(tmate -S /tmp/tmate.sock display -p '#{tmate-ssh-ro}');
      echo "TMATE_COMPLETE"
    `;

    // Use SSH to connect to the VM and run the script
    const sshCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${sshPort} ${username}@127.0.0.1 "bash -l"`;

    // We'll use the existing SSH infrastructure via the ssh2 library approach
    // For the actual implementation, we connect via SSH2 client
    const { Client } = require('ssh2');
    const conn = new Client();

    const result = await new Promise((resolve, reject) => {
      let output = '';
      let timeout = setTimeout(() => {
        conn.end();
        reject(new Error('SSH connection timed out'));
      }, 30000);

      conn.on('ready', () => {
        conn.exec(innerScript, (err, stream) => {
          if (err) {
            clearTimeout(timeout);
            conn.end();
            return reject(err);
          }

          stream.on('data', (data) => {
            output += data.toString();
          });

          stream.stderr.on('data', (data) => {
            // Some errors are expected (e.g., apt output)
          });

          stream.on('close', () => {
            clearTimeout(timeout);
            conn.end();

            // Parse tmate output
            const sshMatch = output.match(/SSH:\s+(ssh\s+[^\n]+)/);
            const roMatch = output.match(/READONLY:\s+(ssh\s+[^\n]+)/);
            const complete = output.includes('TMATE_COMPLETE');

            if (complete && sshMatch) {
              resolve({
                sshCommand: sshMatch[1].trim(),
                readonlyCommand: roMatch ? roMatch[1].trim() : null,
                sessionIdentifier: sshMatch[1].match(/(\w+@\w+)/)?.[0] || 'unknown'
              });
            } else {
              reject(new Error('Failed to generate tmate session. VM may not have tmate installed or network access.'));
            }
          });
        });
      });

      conn.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`SSH connection failed: ${err.message}`));
      });

      // Connect using VM credentials
      conn.connect({
        host: '127.0.0.1',
        port: parseInt(sshPort),
        username: username,
        password: password,
        readyTimeout: 15000,
        // Allow keyboard-interactive for password prompts
        tryKeyboard: true,
        algorithms: {
          serverHostKey: ['ssh-rsa', 'ecdsa-sha2-nistp256', 'ssh-ed25519', 'rsa-sha2-256', 'rsa-sha2-512']
        }
      });

      // Handle keyboard-interactive auth
      conn.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
        finish([password]);
      });
    });

    // Update session in database
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE tmate_sessions SET session_identifier = ?, ssh_command = ?, readonly_command = ?, status = 'active' WHERE id = ?`,
        [result.sessionIdentifier, result.sshCommand, result.readonlyCommand, sessionId],
        (err) => err ? reject(err) : resolve()
      );
    });

    // Fetch and return the complete session
    const session = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM tmate_sessions WHERE id = ?`, [sessionId], (err, row) => err ? reject(err) : resolve(row));
    });

    // Audit log
    if (auditLog) {
      auditLog.log({
        userId,
        username: vm.username,
        action: 'tmate_session_created',
        resourceType: 'vm',
        resourceId: String(vm.vm_id),
        details: `tmate session generated for VM ${vm.vm_name} (ID: ${vm.vm_id})`,
        ipAddress,
        source: 'panel',
        result: 'SUCCESS'
      });
    }

    return { success: true, session };
  } catch (error) {
    // Mark session as failed
    await new Promise((resolve) => {
      db.run(`UPDATE tmate_sessions SET status = 'failed' WHERE id = ?`, [sessionId], () => resolve());
    });

    if (auditLog) {
      auditLog.log({
        userId,
        action: 'tmate_session_failed',
        resourceType: 'vm',
        resourceId: String(vm.vm_id),
        details: `Failed: ${error.message}`,
        ipAddress,
        source: 'panel',
        result: 'FAILURE'
      });
    }

    throw error;
  }
}

/**
 * Revoke a tmate session
 */
async function revokeSession(sessionId, userId, ipAddress) {
  const session = await new Promise((resolve, reject) => {
    db.get(`SELECT * FROM tmate_sessions WHERE id = ?`, [sessionId], (err, row) => err ? reject(err) : resolve(row));
  });

  if (!session) throw new Error('Session not found');
  if (session.user_id !== userId) throw new Error('Access denied');

  // Try to kill tmate on the VM
  try {
    const vm = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM vms WHERE vm_id = ?`, [session.vm_id], (err, row) => err ? reject(err) : resolve(row));
    });

    if (vm && vm.status === 'running') {
      const { Client } = require('ssh2');
      const conn = new Client();
      const sshPort = vm.ssh_port || vm.ssh_port_static || 22;

      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 10000);
        conn.on('ready', () => {
          conn.exec('pkill tmate 2>/dev/null; rm -f /tmp/tmate.sock', () => {
            clearTimeout(timeout);
            conn.end();
            resolve();
          });
        });
        conn.on('error', () => { clearTimeout(timeout); resolve(); });
        conn.connect({
          host: '127.0.0.1',
          port: parseInt(sshPort),
          username: vm.username || 'root',
          password: vm.password || '',
          readyTimeout: 10000,
          tryKeyboard: true,
          algorithms: { serverHostKey: ['ssh-rsa', 'ecdsa-sha2-nistp256', 'ssh-ed25519', 'rsa-sha2-256', 'rsa-sha2-512'] }
        });
        conn.on('keyboard-interactive', (n, i, l, p, f) => f([vm.password || '']));
      });
    }
  } catch (e) {
    // Best effort - session will expire anyway
  }

  await new Promise((resolve, reject) => {
    db.run(
      `UPDATE tmate_sessions SET status = 'revoked', revoked_at = datetime('now') WHERE id = ?`,
      [sessionId],
      (err) => err ? reject(err) : resolve()
    );
  });

  if (auditLog) {
    auditLog.log({
      userId,
      action: 'tmate_session_revoked',
      resourceType: 'tmate_session',
      resourceId: String(sessionId),
      details: `Revoked tmate session for VM ID ${session.vm_id}`,
      ipAddress,
      source: 'panel',
      result: 'SUCCESS'
    });
  }

  return { success: true, message: 'Session revoked' };
}

/**
 * Get active sessions for a user
 */
function getActiveSessions(userId, callback) {
  db.all(
    `SELECT ts.*, v.vm_name FROM tmate_sessions ts
     LEFT JOIN vms v ON ts.vm_id = v.vm_id
     WHERE ts.user_id = ? AND ts.status = 'active' AND (ts.expires_at IS NULL OR ts.expires_at > datetime('now'))
     ORDER BY ts.created_at DESC`,
    [userId],
    callback
  );
}

/**
 * Get sessions for a specific VM
 */
function getVMSessions(vmId, userId, callback) {
  db.all(
    `SELECT * FROM tmate_sessions WHERE vm_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 10`,
    [vmId, userId],
    callback
  );
}

module.exports = { init, generateSession, revokeSession, getActiveSessions, getVMSessions };
