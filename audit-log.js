'use strict';

/**
 * Audit Logging Module for HKVM Panel
 * Logs all privileged operations for security tracking
 */

let db = null;

function init(database) {
  db = database;
  // Create audit_logs table if not exists
  db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    action TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    details TEXT,
    ip_address TEXT,
    user_agent TEXT,
    source TEXT DEFAULT 'panel',
    result TEXT DEFAULT 'SUCCESS',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  console.log('[Audit] Audit logging initialized');
}

/**
 * Log an audit event
 * @param {Object} params
 * @param {number} params.userId - Panel user ID
 * @param {string} params.username - Username
 * @param {string} params.action - Action performed (e.g., 'vm_deploy', 'vm_start', 'discord_link')
 * @param {string} params.resourceType - Resource type (e.g., 'vm', 'user', 'discord')
 * @param {string} params.resourceId - Resource ID
 * @param {string} params.details - Additional details
 * @param {string} params.ipAddress - Client IP
 * @param {string} params.userAgent - Client user agent
 * @param {string} params.source - Source ('panel', 'discord', 'api')
 * @param {string} params.result - 'SUCCESS' or 'FAILURE'
 */
function log(params) {
  if (!db) {
    console.warn('[Audit] Database not initialized, cannot log audit event');
    return;
  }

  const {
    userId = null,
    username = null,
    action,
    resourceType = null,
    resourceId = null,
    details = null,
    ipAddress = null,
    userAgent = null,
    source = 'panel',
    result = 'SUCCESS'
  } = params;

  db.run(
    `INSERT INTO audit_logs (user_id, username, action, resource_type, resource_id, details, ip_address, user_agent, source, result)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, username, action, resourceType, resourceId, details, ipAddress, userAgent, source, result],
    (err) => {
      if (err) {
        console.error('[Audit] Failed to log audit event:', err.message);
      }
    }
  );
}

/**
 * Get audit logs with pagination
 * @param {Object} options
 * @param {number} options.limit - Max results (default 50)
 * @param {number} options.offset - Offset for pagination
 * @param {string} options.source - Filter by source
 * @param {string} options.action - Filter by action
 * @param {function} callback - Callback with (err, logs)
 */
function getLogs({ limit = 50, offset = 0, source = null, action = null } = {}, callback) {
  if (!db) return callback(new Error('Database not initialized'));

  let query = 'SELECT * FROM audit_logs';
  const conditions = [];
  const params = [];

  if (source) {
    conditions.push('source = ?');
    params.push(source);
  }
  if (action) {
    conditions.push('action = ?');
    params.push(action);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  db.all(query, params, callback);
}

module.exports = { init, log, getLogs };
