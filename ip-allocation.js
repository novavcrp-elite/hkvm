'use strict';

/**
 * IP Address Allocation Module for HKVM Panel
 * Manages IP address allocation, prevents duplicates, tracks resource usage
 */

let db = null;
let auditLog = null;

function init(database, audit) {
  db = database;
  auditLog = audit;

  // Create ip_addresses table
  db.run(`CREATE TABLE IF NOT EXISTS ip_addresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER,
    address TEXT NOT NULL,
    version INTEGER DEFAULT 4,
    gateway TEXT,
    netmask TEXT DEFAULT '24',
    network TEXT,
    resource_type TEXT,
    resource_id INTEGER,
    status TEXT DEFAULT 'available',
    vlan_id INTEGER,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(node_id) REFERENCES nodes(id)
  )`);

  console.log('[IP] IP allocation module initialized');
}

/**
 * Allocate an IP address to a resource
 */
async function allocateIP(data) {
  const { node_id, address, version, gateway, netmask, network, resource_type, resource_id, vlan_id, description } = data;

  if (!address) throw new Error('IP address is required');
  if (!resource_type || !resource_id) throw new Error('Resource type and ID are required');

  // Check for duplicate allocation
  const existing = await new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM ip_addresses WHERE address = ? AND status = 'allocated' AND node_id = ?`,
      [address, node_id || 0],
      (err, row) => err ? reject(err) : resolve(row)
    );
  });

  if (existing) {
    throw new Error(`IP address ${address} is already allocated to resource ${existing.resource_type}:${existing.resource_id}`);
  }

  // Allocate the IP
  const id = await new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO ip_addresses (node_id, address, version, gateway, netmask, network, resource_type, resource_id, vlan_id, description, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'allocated')`,
      [node_id || null, address, version || 4, gateway || null, netmask || '24', network || null,
       resource_type, resource_id, vlan_id || null, description || ''],
      function(err) { err ? reject(err) : resolve(this.lastID); }
    );
  });

  if (auditLog) {
    auditLog.log({
      action: 'ip_allocated',
      resourceType: 'ip_address',
      resourceId: String(id),
      details: `IP ${address} allocated to ${resource_type}:${resource_id}`,
      source: 'panel',
      result: 'SUCCESS'
    });
  }

  return { id, address, resource_type, resource_id };
}

/**
 * Release an IP address
 */
async function releaseIP(ipId) {
  const ip = await new Promise((resolve, reject) => {
    db.get(`SELECT * FROM ip_addresses WHERE id = ?`, [ipId], (err, row) => err ? reject(err) : resolve(row));
  });

  if (!ip) throw new Error('IP address not found');

  await new Promise((resolve, reject) => {
    db.run(`UPDATE ip_addresses SET status = 'available', resource_type = NULL, resource_id = NULL, updated_at = datetime('now') WHERE id = ?`,
      [ipId], (err) => err ? reject(err) : resolve());
  });

  if (auditLog) {
    auditLog.log({
      action: 'ip_released',
      resourceType: 'ip_address',
      resourceId: String(ipId),
      details: `IP ${ip.address} released`,
      source: 'panel',
      result: 'SUCCESS'
    });
  }

  return { success: true };
}

/**
 * Get available IPs for a node
 */
function getAvailableIPs(nodeId, version = 4) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM ip_addresses WHERE node_id = ? AND version = ? AND status = 'available' ORDER BY address`,
      [nodeId, version],
      (err, rows) => err ? reject(err) : resolve(rows || [])
    );
  });
}

/**
 * Get allocated IPs for a resource
 */
function getResourceIPs(resourceType, resourceId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM ip_addresses WHERE resource_type = ? AND resource_id = ? AND status = 'allocated'`,
      [resourceType, resourceId],
      (err, rows) => err ? reject(err) : resolve(rows || [])
    );
  });
}

/**
 * Get all IPs for a node
 */
function getNodeIPs(nodeId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT * FROM ip_addresses WHERE node_id = ? ORDER BY status, address`,
      [nodeId],
      (err, rows) => err ? reject(err) : resolve(rows || [])
    );
  });
}

/**
 * Check if an IP is available
 */
async function isIPAvailable(address, nodeId) {
  const existing = await new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM ip_addresses WHERE address = ? AND status = 'allocated'`,
      [address],
      (err, row) => err ? reject(err) : resolve(row)
    );
  });
  return !existing;
}

module.exports = { init, allocateIP, releaseIP, getAvailableIPs, getResourceIPs, getNodeIPs, isIPAvailable };
