'use strict';

/**
 * Internal API Routes for Discord Bot
 * Secure endpoints for Discord bot to interact with VM management
 */

const crypto = require('crypto');

function setupRoutes(app, db, auditLog, OS_TEMPLATES) {
  /**
   * Middleware: Internal API authentication
   * Uses a shared secret between the panel and Discord bot
   */
  function checkInternalAuth(req, res, next) {
    const authHeader = req.headers['x-internal-api-secret'];
    const expectedSecret = process.env.INTERNAL_API_SECRET;

    if (!expectedSecret) {
      console.error('[Internal API] INTERNAL_API_SECRET not configured');
      return res.status(500).json({ error: 'Internal API not configured' });
    }

    if (!authHeader || authHeader !== expectedSecret) {
      if (auditLog) {
        auditLog.log({
          action: 'internal_api_unauthorized',
          details: `Unauthorized access attempt to ${req.method} ${req.path}`,
          ipAddress: req.ip,
          source: 'api',
          result: 'FAILURE'
        });
      }
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  }

  /**
   * Rate limiter for internal API
   */
  const rateLimitMap = new Map();
  function rateLimit(req, res, next) {
    const key = req.ip;
    const now = Date.now();
    const windowMs = 60000; // 1 minute window
    const maxRequests = 60;

    const record = rateLimitMap.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > record.resetAt) {
      record.count = 0;
      record.resetAt = now + windowMs;
    }
    record.count++;
    rateLimitMap.set(key, record);

    if (record.count > maxRequests) {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    next();
  }

  // Apply middleware to all internal routes
  const prefix = '/api/internal/discord';

  // ============= VM OPERATIONS =============

  /**
   * POST /api/internal/discord/deploy
   * Deploy a new VM
   */
  app.post(`${prefix}/deploy`, checkInternalAuth, rateLimit, async (req, res) => {
    try {
      const {
        vm_name, os_template, hostname, custom_memory, custom_cpus,
        disk_size, custom_username, custom_password,
        cpu_sockets, cpu_cores, cpu_threads, cpu_model,
        network_type, ipv4_address, gateway, owner_id
      } = req.body;

      if (!vm_name || !os_template) {
        return res.status(400).json({ error: 'vm_name and os_template are required' });
      }

      // Reuse existing VM creation logic from app.js
      // We need to construct the same data structure
      const path = require('path');
      const os = require('os');
      const { execSync } = require('child_process');

      const VM_DIR = path.join(os.homedir(), 'vms');
      const CLOUDVM_DIR = path.join(VM_DIR, 'cloudvm');
      const ISO_DIR = path.join(VM_DIR, 'iso');

      // Get template info (OS_TEMPLATES passed from app.js)
      let isCloudInit = false;
      let templateName = 'Custom ISO';
      let username = custom_username || 'root';
      let password = custom_password || 'password';
      let template = null;

      if (OS_TEMPLATES[os_template]) {
        template = OS_TEMPLATES[os_template];
        isCloudInit = true;
        templateName = template.name;
        username = custom_username || template.username;
        password = custom_password || template.password;
      }

      const memory = custom_memory || (template ? template.memory : 2048);
      const cpuCount = custom_cpus || (template ? template.cpus : 2);
      const diskSizeVal = disk_size || (template ? template.disk_size : '20G');
      const netType = network_type || 'dhcp';
      const macAddr = 'fa:16:3e:' + [0,1,2].map(() => Math.floor(Math.random()*256).toString(16).padStart(2,'0')).join(':');
      const vmOwner = owner_id || 1;

      const vmId = await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO vms (vm_name, os_type, template_type, hostname, username, password,
            memory, cpus, cpu_sockets, cpu_cores, cpu_threads, cpu_model,
            disk_size, status, network_type, owner_id, mac_address,
            smbios_manufacturer, smbios_serial)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopped', ?, ?, ?, 'QEMU', ?)`,
          [vm_name, templateName, os_template, hostname || vm_name, username, password,
            memory, cpuCount, cpu_sockets||1, cpu_cores||cpuCount, cpu_threads||1, cpu_model||'host',
            diskSizeVal, netType, vmOwner, macAddr, `vm-${Date.now()}`],
          function(err) { err ? reject(err) : resolve(this.lastID); }
        );
      });

      const diskFile = path.join(VM_DIR, `vm-${vmId}-disk.qcow2`);
      const seedFile = path.join(VM_DIR, `vm-${vmId}-seed.iso`);
      const imgFile = isCloudInit ? path.join(CLOUDVM_DIR, `${os_template}-${vmId}.qcow2`) : path.join(ISO_DIR, `${os_template}-${vmId}.qcow2`);

      await new Promise((resolve, reject) => {
        db.run(`UPDATE vms SET img_file=?, seed_file=?, disk_file=? WHERE vm_id=?`,
          [imgFile, seedFile, diskFile, vmId], (err) => err ? reject(err) : resolve());
      });

      // Create disk
      execSync(`qemu-img create -f qcow2 "${diskFile}" ${diskSizeVal}`, { stdio: 'pipe' });

      if (auditLog) {
        auditLog.log({
          action: 'internal_vm_deploy',
          resourceType: 'vm',
          resourceId: String(vmId),
          details: `VM ${vm_name} (ID: ${vmId}) deployed via internal API`,
          source: 'discord',
          result: 'SUCCESS'
        });
      }

      res.json({
        success: true,
        vm_id: vmId,
        vm_name,
        status: 'stopped',
        username,
        password,
        disk_size: diskSizeVal,
        memory,
        cpus: cpuCount
      });
    } catch (err) {
      console.error('[Internal API] Deploy error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/internal/discord/vms
   * List all VMs
   */
  app.get(`${prefix}/vms`, checkInternalAuth, rateLimit, (req, res) => {
    db.all(
      `SELECT vm_id, vm_name, status, os_type, memory, cpus, disk_size, network_type, ipv4_address, owner_id
       FROM vms ORDER BY vm_id DESC`,
      [],
      (err, vms) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(vms || []);
      }
    );
  });

  /**
   * GET /api/internal/discord/vm/:id
   * Get VM details
   */
  app.get(`${prefix}/vm/:id`, checkInternalAuth, rateLimit, (req, res) => {
    db.get(`SELECT * FROM vms WHERE vm_id = ?`, [req.params.id], (err, vm) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!vm) return res.status(404).json({ error: 'VM not found' });
      // Strip sensitive fields
      delete vm.password;
      res.json(vm);
    });
  });

  /**
   * POST /api/internal/discord/vm/:id/start
   */
  app.post(`${prefix}/vm/:id/start`, checkInternalAuth, rateLimit, async (req, res) => {
    try {
      db.get(`SELECT * FROM vms WHERE vm_id = ?`, [req.params.id], (err, vm) => {
        if (err || !vm) return res.status(404).json({ error: 'VM not found' });
        if (vm.status === 'running') return res.status(400).json({ error: 'VM already running' });

        // Start VM using exec
        const path = require('path');
        const os = require('os');
        const fs = require('fs');
        const { execSync } = require('child_process');

        const VM_DIR = path.join(os.homedir(), 'vms');
        const pidFile = path.join(VM_DIR, `vm-${vm.vm_id}.pid`);

        if (!vm.disk_file || !fs.existsSync(vm.disk_file)) {
          return res.status(400).json({ error: 'Disk file not found' });
        }

        const args = [
          `-m ${vm.memory}`, `-smp cores=${vm.cpu_cores},threads=${vm.cpu_threads},sockets=${vm.cpu_sockets}`,
          `-cpu ${vm.cpu_model||'host'}`, `-name vm-${vm.vm_id}`,
          `-machine ${vm.machine_type||'pc'},accel=kvm:tcg`, `-enable-kvm`, `-nographic`,
          `-drive file=${vm.disk_file},format=qcow2,if=virtio,media=disk`,
          `-netdev user,id=net0,hostfwd=tcp::${vm.ssh_port||22}-:22`,
          `-device virtio-net-pci,netdev=net0`, `-vnc 127.0.0.1:${5900+vm.vm_id}`,
          `-serial mon:stdio`
        ];

        if (vm.seed_file && fs.existsSync(vm.seed_file)) {
          args.push(`-drive file=${vm.seed_file},format=raw,media=cdrom,if=ide,index=1`);
        }

        try {
          const { stdout } = execSync(`nohup qemu-system-x86_64 ${args.join(' ')} > /dev/null 2>&1 & echo $!`, { shell: '/bin/bash', encoding: 'utf8' });
          const pid = parseInt(stdout.trim());
          if (pid) {
            fs.writeFileSync(pidFile, String(pid));
            db.run(`UPDATE vms SET status = 'running' WHERE vm_id = ?`, [vm.vm_id]);
            res.json({ success: true, pid, message: `VM ${vm.vm_name} started` });
          } else {
            res.status(500).json({ error: 'Failed to start VM' });
          }
        } catch (e) {
          res.status(500).json({ error: e.message });
        }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/internal/discord/vm/:id/stop
   */
  app.post(`${prefix}/vm/:id/stop`, checkInternalAuth, rateLimit, (req, res) => {
    db.get(`SELECT * FROM vms WHERE vm_id = ?`, [req.params.id], (err, vm) => {
      if (err || !vm) return res.status(404).json({ error: 'VM not found' });
      if (vm.status === 'stopped') return res.status(400).json({ error: 'VM already stopped' });

      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const pidFile = path.join(os.homedir(), 'vms', `vm-${vm.vm_id}.pid`);

      if (fs.existsSync(pidFile)) {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
        try { require('child_process').execSync(`kill -9 ${pid}`, { stdio: 'pipe' }); } catch (e) {}
        fs.unlinkSync(pidFile);
      }

      db.run(`UPDATE vms SET status = 'stopped' WHERE vm_id = ?`, [vm.vm_id]);
      res.json({ success: true, message: `VM ${vm.vm_name} stopped` });
    });
  });

  /**
   * POST /api/internal/discord/vm/:id/restart
   */
  app.post(`${prefix}/vm/:id/restart`, checkInternalAuth, rateLimit, (req, res) => {
    // Stop then start
    db.get(`SELECT * FROM vms WHERE vm_id = ?`, [req.params.id], (err, vm) => {
      if (err || !vm) return res.status(404).json({ error: 'VM not found' });

      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const pidFile = path.join(os.homedir(), 'vms', `vm-${vm.vm_id}.pid`);

      if (fs.existsSync(pidFile)) {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
        try { require('child_process').execSync(`kill -9 ${pid}`, { stdio: 'pipe' }); } catch (e) {}
        fs.unlinkSync(pidFile);
      }

      db.run(`UPDATE vms SET status = 'stopped' WHERE vm_id = ?`, [vm.vm_id], () => {
        res.json({ success: true, message: `VM ${vm.vm_name} restarted (stopped, start manually or use start command)` });
      });
    });
  });

  /**
   * DELETE /api/internal/discord/vm/:id
   */
  app.delete(`${prefix}/vm/:id`, checkInternalAuth, rateLimit, (req, res) => {
    db.get(`SELECT * FROM vms WHERE vm_id = ?`, [req.params.id], (err, vm) => {
      if (err || !vm) return res.status(404).json({ error: 'VM not found' });

      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      const pidFile = path.join(os.homedir(), 'vms', `vm-${vm.vm_id}.pid`);

      if (fs.existsSync(pidFile)) {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
        try { require('child_process').execSync(`kill -9 ${pid}`, { stdio: 'pipe' }); } catch (e) {}
        fs.unlinkSync(pidFile);
      }

      if (vm.img_file && fs.existsSync(vm.img_file)) try { fs.unlinkSync(vm.img_file); } catch (e) {}
      if (vm.seed_file && fs.existsSync(vm.seed_file)) try { fs.unlinkSync(vm.seed_file); } catch (e) {}
      if (vm.disk_file && fs.existsSync(vm.disk_file)) try { fs.unlinkSync(vm.disk_file); } catch (e) {}

      db.run(`DELETE FROM vms WHERE vm_id = ?`, [vm.vm_id]);
      db.run(`DELETE FROM vm_logs WHERE vm_id = ?`, [vm.vm_id]);
      db.run(`DELETE FROM vm_snapshots WHERE vm_id = ?`, [vm.vm_id]);

      if (auditLog) {
        auditLog.log({
          action: 'internal_vm_delete',
          resourceType: 'vm',
          resourceId: String(vm.vm_id),
          details: `VM ${vm.vm_name} (ID: ${vm.vm_id}) deleted via internal API`,
          source: 'discord',
          result: 'SUCCESS'
        });
      }

      res.json({ success: true, message: `VM ${vm.vm_name} deleted` });
    });
  });

  // ============= LXC OPERATIONS =============

  /**
   * POST /api/internal/discord/lxc
   * Deploy a new LXC container
   */
  app.post(`${prefix}/lxc`, checkInternalAuth, rateLimit, async (req, res) => {
    try {
      const lxcModule = require('./lxc');
      const { name, template_key, cpu_cores, memory, disk_size, password, node_id, network_type, ipv4_address, hostname, description } = req.body;

      if (!name) return res.status(400).json({ error: 'Container name is required' });

      const ownerId = req.body.owner_id || 1;
      const result = await lxcModule.createContainer({
        name, node_id, template_key, cpu_cores, memory, disk_size,
        password: password || 'password', network_type, ipv4_address, hostname, description
      }, ownerId, '127.0.0.1');

      if (auditLog) {
        auditLog.log({ action: 'internal_lxc_deploy', resourceType: 'lxc', resourceId: String(result.id),
          details: `LXC ${name} (ID: ${result.id}) deployed via internal API`, source: 'discord', result: 'SUCCESS' });
      }
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[Internal API] LXC deploy error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/internal/discord/lxc/:id/start
   */
  app.post(`${prefix}/lxc/:id/start`, checkInternalAuth, rateLimit, async (req, res) => {
    try {
      const lxcModule = require('./lxc');
      const result = await lxcModule.startContainer(parseInt(req.params.id), 1, true);
      if (auditLog) auditLog.log({ action: 'internal_lxc_start', resourceType: 'lxc', resourceId: req.params.id, source: 'discord', result: 'SUCCESS' });
      res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  /**
   * POST /api/internal/discord/lxc/:id/stop
   */
  app.post(`${prefix}/lxc/:id/stop`, checkInternalAuth, rateLimit, async (req, res) => {
    try {
      const lxcModule = require('./lxc');
      const result = await lxcModule.stopContainer(parseInt(req.params.id), 1, true);
      if (auditLog) auditLog.log({ action: 'internal_lxc_stop', resourceType: 'lxc', resourceId: req.params.id, source: 'discord', result: 'SUCCESS' });
      res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  /**
   * POST /api/internal/discord/lxc/:id/restart
   */
  app.post(`${prefix}/lxc/:id/restart`, checkInternalAuth, rateLimit, async (req, res) => {
    try {
      const lxcModule = require('./lxc');
      const result = await lxcModule.restartContainer(parseInt(req.params.id), 1, true);
      res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  /**
   * DELETE /api/internal/discord/lxc/:id
   */
  app.delete(`${prefix}/lxc/:id`, checkInternalAuth, rateLimit, async (req, res) => {
    try {
      const lxcModule = require('./lxc');
      const result = await lxcModule.deleteContainer(parseInt(req.params.id), 1, true);
      if (auditLog) auditLog.log({ action: 'internal_lxc_delete', resourceType: 'lxc', resourceId: req.params.id, source: 'discord', result: 'SUCCESS' });
      res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  /**
   * GET /api/internal/discord/lxc/:id/console
   */
  app.get(`${prefix}/lxc/:id/console`, checkInternalAuth, rateLimit, async (req, res) => {
    try {
      const lxcModule = require('./lxc');
      const info = await lxcModule.getConsoleInfo(parseInt(req.params.id), 1, true);
      res.json(info);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  /**
   * GET /api/internal/discord/lxcs
   * List all LXC containers
   */
  app.get(`${prefix}/lxcs`, checkInternalAuth, rateLimit, async (req, res) => {
    try {
      const lxcModule = require('./lxc');
      const containers = await lxcModule.listContainers(1, true);
      res.json(containers);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  /**
   * GET /api/internal/discord/lxc/:id
   * Get single LXC container details
   */
  app.get(`${prefix}/lxc/:id`, checkInternalAuth, rateLimit, async (req, res) => {
    try {
      const lxcModule = require('./lxc');
      const container = await lxcModule.getContainer(parseInt(req.params.id), 1, true);
      if (!container) return res.status(404).json({ error: 'Container not found' });
      const safe = { ...container, password: undefined };
      res.json(safe);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ============= AUDIT LOGS =============

  /**
   * GET /api/internal/discord/audit-logs
   */
  app.get(`${prefix}/audit-logs`, checkInternalAuth, rateLimit, (req, res) => {
    if (!auditLog) return res.json([]);
    const { limit = 50, offset = 0, source } = req.query;
    auditLog.getLogs({ limit: parseInt(limit), offset: parseInt(offset), source }, (err, logs) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(logs || []);
    });
  });

  console.log('[Internal API] Discord internal API routes registered');
}

module.exports = { setupRoutes };
