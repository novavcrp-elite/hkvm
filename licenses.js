// license_client.js - License verification client for HKVM Panel
// Node.js version

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

// ============= CONFIGURATION =============
// All settings hardcoded here - NO external .env changes possible
const LICENSE_SERVER_URL = 'https://license.hvmpanel.xyz';           // License server URL
const RECHECK_INTERVAL = 300;                                  // 5 minutes (seconds)
const MAX_ENVELOPE_AGE = Math.max(RECHECK_INTERVAL * 3, 900); // 15 minutes (seconds)
const HTTP_TIMEOUT = 15000;                                    // 15 seconds (milliseconds)
const NETWORK_GRACE = 3;                                       // Allow 3 network failures
const PANEL_VERSION = 'V1.0';                                  // Panel version
const DEBUG_MODE = false;                                      // Debug logging
const DB_PATH = 'hvm.db';                                      // Database file path

// Embedded Ed25519 public key (PEM format) - MUST match server's public key
// Can be overridden with LICENSE_PUBLIC_KEY environment variable
const EMBEDDED_PUB_KEY_PEM = process.env.LICENSE_PUBLIC_KEY || `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAK+tWEd01AxJy+H+p5kYTT0L81Y+vYHBnC2SnaRyEKeU=
-----END PUBLIC KEY-----
`;

// Database path (hardcoded, cannot be changed externally)
let dbPath = DB_PATH;
let db = null;
let publicKeyObj = null;

// Machine ID is derived from hardware - no persistent storage
let cachedMachineId = null;

// Logger utility - uses hardcoded DEBUG_MODE
const logger = {
    info: (...args) => console.log('[INFO]', new Date().toISOString(), ...args),
    warn: (...args) => console.warn('[WARN]', new Date().toISOString(), ...args),
    error: (...args) => console.error('[ERROR]', new Date().toISOString(), ...args),
    debug: (...args) => {
        if (DEBUG_MODE === true) {
            console.debug('[DEBUG]', new Date().toISOString(), ...args);
        }
    },
    exception: (...args) => console.error('[EXCEPTION]', new Date().toISOString(), ...args)
};

// Utility functions
function utcNow() {
    return new Date().toISOString();
}

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

// ============= HARDWARE-BASED MACHINE ID (NO FILE STORAGE) =============
// Machine ID is derived from actual hardware - recalculated on each startup
// Cannot be bypassed by sharing files - tied to actual machine hardware

async function generateMachineIdFromHardware() {
    try {
        const os = require('os');
        const { exec } = require('child_process');
        const util = require('util');
        const execPromise = util.promisify(exec);

        let hardwareData = '';

        // 1. Hostname
        const hostname = os.hostname();
        hardwareData += `hostname:${hostname}|`;

        // 2. MAC Addresses (all network interfaces)
        const interfaces = os.networkInterfaces();
        const macs = [];
        for (const [name, addrs] of Object.entries(interfaces)) {
            for (const addr of addrs) {
                if (addr.mac && addr.mac !== '00:00:00:00:00:00') {
                    macs.push(addr.mac);
                }
            }
        }
        const sortedMacs = macs.sort().join('|');
        hardwareData += `macs:${sortedMacs}|`;

        // 3. Platform-specific hardware identifiers
        if (process.platform === 'win32') {
            try {
                // Windows: System UUID
                const { stdout: uuid } = await execPromise('wmic csproduct get uuid');
                const systemUuid = uuid.split('\n')[1]?.trim();
                if (systemUuid) hardwareData += `uuid:${systemUuid}|`;

                // Windows: Serial Number
                try {
                    const { stdout: serial } = await execPromise('wmic bios get serialnumber');
                    const serialNum = serial.split('\n')[1]?.trim();
                    if (serialNum) hardwareData += `serial:${serialNum}|`;
                } catch (e) {
                    logger.debug('Could not get BIOS serial:', e.message);
                }

                // Windows: Motherboard Serial
                try {
                    const { stdout: mbserial } = await execPromise('wmic baseboard get serialnumber');
                    const mbSerialNum = mbserial.split('\n')[1]?.trim();
                    if (mbSerialNum) hardwareData += `mb_serial:${mbSerialNum}|`;
                } catch (e) {
                    logger.debug('Could not get MB serial:', e.message);
                }
            } catch (e) {
                logger.debug('Windows hardware detection failed:', e.message);
            }
        } else if (process.platform === 'linux') {
            try {
                // Linux: machine-id
                const machineId = await fs.promises.readFile('/etc/machine-id', 'utf8');
                hardwareData += `machine-id:${machineId.trim()}|`;
            } catch (e) {
                logger.debug('Could not read /etc/machine-id:', e.message);
            }

            try {
                // Linux: DMI serial
                const dmiSerial = await fs.promises.readFile('/sys/class/dmi/id/system-serial-number', 'utf8');
                hardwareData += `dmi_serial:${dmiSerial.trim()}|`;
            } catch (e) {
                logger.debug('Could not read DMI serial:', e.message);
            }
        }

        // 4. CPU info
        const cpus = os.cpus();
        const cpuModel = cpus[0]?.model || 'unknown';
        const cpuCount = cpus.length;
        hardwareData += `cpu:${cpuModel}|cpu_count:${cpuCount}|`;

        // 5. Platform and Architecture
        hardwareData += `platform:${process.platform}|arch:${process.arch}|`;

        // Create SHA256 hash of all hardware data
        const machineId = sha256(hardwareData);
        
        logger.info('[License] Generated machine ID from hardware fingerprint');
        logger.debug('[License] Hardware components:', hardwareData.substring(0, 100) + '...');
        
        return machineId;
    } catch (error) {
        logger.error('[License] Hardware fingerprinting failed:', error.message);
        // Fallback: generate a temporary ID (should not happen in normal operation)
        const { v4: uuidv4 } = require('uuid');
        return uuidv4();
    }
}

// Hardware Fingerprinting - ULTRA-SECURE BINDING
async function generateHardwareFingerprint() {
    try {
        const os = require('os');
        const { exec } = require('child_process');
        const util = require('util');
        const execPromise = util.promisify(exec);

        let fingerprint = '';

        // Get hostname
        fingerprint += `hostname:${os.hostname()}`;

        // Get all network interfaces and MAC addresses
        const interfaces = os.networkInterfaces();
        const macs = [];
        for (const [name, addrs] of Object.entries(interfaces)) {
            for (const addr of addrs) {
                if (addr.mac && addr.mac !== '00:00:00:00:00:00') {
                    macs.push(addr.mac);
                }
            }
        }
        fingerprint += `|macs:${macs.sort().join(',')}`;

        // Get platform-specific hardware info
        if (process.platform === 'win32') {
            try {
                // Windows: Get system UUID from WMI
                const { stdout } = await execPromise('wmic csproduct get uuid');
                const uuid = stdout.split('\n')[1]?.trim();
                if (uuid) fingerprint += `|uuid:${uuid}`;
            } catch (e) {
                logger.debug('Could not get Windows UUID:', e.message);
            }
        } else if (process.platform === 'linux') {
            try {
                // Linux: Get machine-id
                const machineId = await fs.promises.readFile('/etc/machine-id', 'utf8');
                fingerprint += `|machine-id:${machineId.trim()}`;
            } catch (e) {
                logger.debug('Could not read /etc/machine-id:', e.message);
            }
        }

        // Hash the fingerprint for consistent format
        return sha256(fingerprint);
    } catch (error) {
        logger.warn('Hardware fingerprinting failed:', error.message);
        return null; // Fallback - server will handle
    }
}

function xorBytes(data, key) {
    if (!key || key.length === 0) return data;
    const result = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) {
        result[i] = data[i] ^ key[i % key.length];
    }
    return result;
}

function keyForMachine(machineId, salt) {
    return crypto.createHash('sha256')
        .update(Buffer.concat([
            Buffer.from('license::' + machineId),
            salt
        ]))
        .digest();
}

function encryptKey(plain, machineId) {
    const salt = crypto.randomBytes(16);
    const blob = xorBytes(Buffer.from(plain, 'utf8'), keyForMachine(machineId, salt));
    return Buffer.concat([salt, blob]).toString('base64');
}

function decryptKey(blobB64, machineId) {
    if (!blobB64) return null;
    try {
        const raw = Buffer.from(blobB64, 'base64');
        const salt = raw.slice(0, 16);
        const blob = raw.slice(16);
        return xorBytes(blob, keyForMachine(machineId, salt)).toString('utf8');
    } catch (error) {
        return null;
    }
}

// Public key loading
function resolvePubKeyPem() {
    // Priority 1: Environment variable LICENSE_PUBLIC_KEY (most secure)
    const envPem = (process.env.LICENSE_PUBLIC_KEY || '').trim();
    if (envPem && envPem.length > 50) {
        return envPem;
    }
    
    // Priority 2: Environment variable pointing to file
    const envFile = (process.env.LICENSE_PUBLIC_KEY_FILE || '').trim();
    if (envFile && fs.existsSync(envFile)) {
        try {
            return fs.readFileSync(envFile, 'utf8').trim();
        } catch (error) {
            logger.warn('Could not read LICENSE_PUBLIC_KEY_FILE:', error.message);
        }
    }
    
    // Priority 3: Embedded key
    let pem = EMBEDDED_PUB_KEY_PEM;
    if (!pem || pem.includes('REPLACE_WITH_YOUR_PUBLIC_KEY_PEM_BLOCK')) {
        logger.error('License public key is not configured. Set LICENSE_PUBLIC_KEY environment variable or LICENSE_PUBLIC_KEY_FILE.');
        return null;
    }
    
    return pem;
}

function loadPublicKey() {
    if (publicKeyObj) return publicKeyObj;
    const pem = resolvePubKeyPem();
    if (!pem || pem.includes('REPLACE_WITH_YOUR_PUBLIC_KEY_PEM_BLOCK')) {
        logger.error('License public key is not configured. Run the setup script to provision this panel.');
        return null;
    }
    try {
        // For Ed25519, we need to use the PEM format directly with crypto.verify()
        // Node.js crypto.verify() handles Ed25519 PEM keys correctly
        publicKeyObj = pem;
        return publicKeyObj;
    } catch (error) {
        logger.error('Failed to load license public key:', error.message);
        return null;
    }
}

function getPublicKeyFingerprint() {
    const pem = resolvePubKeyPem();
    const normalized = pem.split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .join('\n');
    return sha256(Buffer.from(normalized));
}

function getServerUrl() {
    return LICENSE_SERVER_URL.replace(/\/$/, '');
}

// Database initialization
async function initLicenseStorage(customDbPath = null, sharedDb = null) {
    if (customDbPath) {
        dbPath = customDbPath;
    }
    
    // If a shared database connection is provided, use it
    if (sharedDb) {
        db = sharedDb;
    } else {
        db = await open({
            filename: dbPath,
            driver: sqlite3.Database
        });
    }
    
    // Enable WAL mode to reduce locking conflicts
    try {
        await db.exec('PRAGMA journal_mode = WAL');
        await db.exec('PRAGMA busy_timeout = 5000');
    } catch (e) {
        logger.debug('Could not set WAL mode:', e.message);
    }
    
    await db.exec(`
        CREATE TABLE IF NOT EXISTS license_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            machine_id TEXT,
            hardware_fingerprint TEXT,
            status TEXT,
            usage_type TEXT,
            max_activations INTEGER,
            owner TEXT,
            expires_at TEXT,
            last_check_at TEXT,
            last_success_at TEXT,
            last_error TEXT,
            failure_count INTEGER NOT NULL DEFAULT 0,
            activation_failures INTEGER NOT NULL DEFAULT 0,
            activated_at TEXT,
            activated_by TEXT,
            server_url TEXT,
            key_blob TEXT,
            cached_envelope TEXT,
            cache_integrity_check TEXT
        )
    `);
    
    // Migrations for older deployments
    const columns = [
        ['machine_id', 'TEXT'],
        ['hardware_fingerprint', 'TEXT'],
        ['status', 'TEXT'],
        ['usage_type', 'TEXT'],
        ['max_activations', 'INTEGER'],
        ['owner', 'TEXT'],
        ['expires_at', 'TEXT'],
        ['last_check_at', 'TEXT'],
        ['last_success_at', 'TEXT'],
        ['last_error', 'TEXT'],
        ['failure_count', 'INTEGER NOT NULL DEFAULT 0'],
        ['activation_failures', 'INTEGER NOT NULL DEFAULT 0'],
        ['activated_at', 'TEXT'],
        ['activated_by', 'TEXT'],
        ['server_url', 'TEXT'],
        ['key_blob', 'TEXT'],
        ['cached_envelope', 'TEXT'],
        ['cache_integrity_check', 'TEXT']
    ];
    
    for (const [col, ddl] of columns) {
        try {
            await db.exec(`ALTER TABLE license_state ADD COLUMN ${col} ${ddl}`);
        } catch (error) {
            // Column already exists, ignore
        }
    }
    
    const count = await db.get('SELECT COUNT(*) as cnt FROM license_state');
    if (count.cnt === 0) {
        await db.run('INSERT INTO license_state (id, failure_count) VALUES (1, 0)');
    }
    
    // Generate machine ID from actual hardware - recalculated every startup
    const hardwareMachineId = await generateMachineIdFromHardware();
    
    const state = await db.get('SELECT machine_id FROM license_state WHERE id = 1');
    if (!state || !state.machine_id) {
        // Store the hardware-derived machine ID in database
        await db.run('UPDATE license_state SET machine_id = ? WHERE id = 1', [hardwareMachineId]);
        logger.info('[License] Machine ID derived from hardware and stored in database');
    } else if (state.machine_id !== hardwareMachineId) {
        // If database has different machine ID, it means hardware changed
        logger.warn('[License] Hardware mismatch detected - updating machine ID');
        logger.warn('[License] Previous: ' + state.machine_id.substring(0, 16) + '...');
        logger.warn('[License] Current:  ' + hardwareMachineId.substring(0, 16) + '...');
        await db.run('UPDATE license_state SET machine_id = ? WHERE id = 1', [hardwareMachineId]);
    }
    
    // ========== IMPROVED: AUTO-RECOVERY ON APP START ==========
    // After initialization, check if we can recover old license key from encrypted blob
    // Add a small delay to allow database to settle before recovery attempt
    setTimeout(async () => {
        try {
            await attemptLicenseRecovery();
        } catch (error) {
            logger.error('[License] Deferred recovery error:', error.message);
        }
    }, 500); // 500ms delay
    
    logger.info('[License] License storage initialized with auto-recovery enabled');
}

// ========== NEW FUNCTION: AUTO-RECOVERY ON RESTART ==========
async function attemptLicenseRecovery() {
    try {
        const state = await getState();
        if (!state) return;
        
        // If license is already active in database, nothing to do
        if (state.status === 'active' && state.key_blob && state.cached_envelope) {
            const verification = await verifyCachedEnvelope(state.cached_envelope, state.machine_id);
            if (verification.ok) {
                logger.info('[License] License already active and verified in database');
                return;
            }
        }
        
        // Try to decrypt stored key if available
        if (!state.key_blob) {
            logger.debug('[License] No stored license key found for recovery');
            return;
        }
        
        const decryptedKey = decryptKey(state.key_blob, state.machine_id);
        if (!decryptedKey) {
            logger.warn('[License] Could not decrypt stored license key');
            return;
        }
        
        logger.info('[License] Found encrypted license key - attempting auto-recovery...');
        
        try {
            // Attempt to revalidate with server using recovered key
            const result = await revalidateWithServer();
            
            if (result.success) {
                logger.info('[License] ✓ AUTO-RECOVERY SUCCESS: License revalidated with recovered key');
                return;
            }
            
            // Server revalidation failed, try activation endpoint as fallback
            logger.warn('[License] Server revalidation failed, attempting activation...');
            const activationResult = await activateWithServer(decryptedKey, 'auto-recovery');
            
            if (activationResult.success) {
                logger.info('[License] ✓ AUTO-RECOVERY SUCCESS: License re-activated with recovered key');
                return;
            }
            
            logger.warn('[License] Auto-recovery failed:', activationResult.message);
        } catch (error) {
            logger.error('[License] Auto-recovery error:', error.message);
        }
    } catch (dbError) {
        // Handle database lock or other database errors gracefully
        if (dbError.message && dbError.message.includes('SQLITE_BUSY')) {
            logger.warn('[License] Database busy during recovery, will retry on next startup');
        } else {
            logger.error('[License] Recovery init error:', dbError.message);
        }
    }
}

async function getState() {
    if (!db) await initLicenseStorage();
    return await db.get('SELECT * FROM license_state WHERE id = 1');
}

async function updateState(fields) {
    if (!db || Object.keys(fields).length === 0) return;
    
    const cols = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    const vals = Object.values(fields);
    
    await db.run(`UPDATE license_state SET ${cols} WHERE id = 1`, vals);
}

async function getMachineId() {
    // Generate machine ID from hardware every time - no caching from database
    // This ensures it's always derived from current hardware state
    const hardwareMachineId = await generateMachineIdFromHardware();
    
    return hardwareMachineId;
}

// Cryptographic verification
function verifySignedResponse(respJson) {
    const pubKey = loadPublicKey();
    if (!pubKey) {
        return { ok: false, data: null, message: 'client missing public key' };
    }
    
    try {
        const envelope = respJson.envelope;
        const signature = respJson.signature;
        const alg = respJson.alg || 'ed25519';
        
        if (alg !== 'ed25519') {
            return { ok: false, data: null, message: `unsupported algorithm: ${alg}` };
        }
        
        // Canonical JSON serialization
        const canonical = JSON.stringify(envelope, Object.keys(envelope).sort());
        const canonicalBuffer = Buffer.from(canonical);
        const signatureBuffer = Buffer.from(signature, 'base64');
        
        // Verify Ed25519 signature using PEM format
        // For Ed25519, crypto.verify() expects:
        // - key: PEM format string (algorithm inferred from key type)
        // - data: Buffer to verify
        // - signature: Buffer signature
        try {
            const verify = crypto.verify(
                null,
                canonicalBuffer,
                pubKey,
                signatureBuffer
            );
            
            if (!verify) {
                return {
                    ok: false,
                    data: null,
                    message: 'signature verification failed - the license server is signing with a different key than the one embedded in this panel. Re-run the setup script to re-provision.'
                };
            }
        } catch (verifyError) {
            logger.debug('Crypto verify error:', verifyError.message);
            throw verifyError;
        }
        
        const ts = parseInt(envelope.ts || '0');
        if (isNaN(ts)) {
            return { ok: false, data: null, message: 'invalid envelope timestamp' };
        }
        
        const drift = Date.now() / 1000 - ts;
        if (ts <= 0 || drift < -120 || drift > MAX_ENVELOPE_AGE) {
            return { ok: false, data: null, message: `stale response (age=${Math.floor(drift)}s)` };
        }
        
        const data = envelope.data || {};
        if (typeof data !== 'object' || Array.isArray(data)) {
            return { ok: false, data: null, message: 'invalid envelope data' };
        }
        
        return { ok: true, data, message: 'ok' };
    } catch (error) {
        logger.debug('Verification caught error:', error.message);
        return { ok: false, data: null, message: `verification error: ${error.message}` };
    }
}

async function verifyCachedEnvelope(rawJson, expectedMachineId) {
    if (!rawJson) {
        return { ok: false, data: null, message: 'no cached envelope' };
    }
    
    try {
        const payload = JSON.parse(rawJson);
        const result = verifySignedResponse(payload);
        
        if (!result.ok) {
            return result;
        }
        
        if (result.data.status !== 'active') {
            return { ok: false, data: result.data, message: `envelope status: ${result.data.status}` };
        }
        
        const envMid = result.data.machine_id;
        if (envMid && envMid !== expectedMachineId) {
            return { ok: false, data: result.data, message: 'machine_id mismatch' };
        }
        
        return { ok: true, data: result.data, message: 'ok' };
    } catch (error) {
        return { ok: false, data: null, message: 'cached envelope unreadable' };
    }
}

// Network communication
async function buildRequest(licenseKey, machineId, hardwareFingerprint = null) {
    return {
        license_key: licenseKey,
        machine_id: machineId,
        hardware_fingerprint: hardwareFingerprint,
        panel_version: PANEL_VERSION,
        ts: Math.floor(Date.now() / 1000),
        nonce: crypto.randomBytes(16).toString('hex')
    };
}

async function makeRequest(path, payload) {
    const url = getServerUrl();
    if (!url) {
        return { ok: false, data: null, envelope: null, message: 'LICENSE_SERVER_URL not configured' };
    }
    
    const fullUrl = url + path;
    const parsedUrl = new URL(fullUrl);
    
    return new Promise((resolve) => {
        const postData = JSON.stringify(payload);
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                'User-Agent': `HVM-Panel/${PANEL_VERSION}`
            },
            timeout: HTTP_TIMEOUT
        };
        
        const requester = parsedUrl.protocol === 'https:' ? https : http;
        const req = requester.request(options, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                if (res.statusCode >= 500) {
                    resolve({
                        ok: false,
                        data: null,
                        envelope: null,
                        message: `server error ${res.statusCode}`
                    });
                    return;
                }
                
                try {
                    const body = JSON.parse(data);
                    const verification = verifySignedResponse(body);
                    
                    if (!verification.ok) {
                        resolve({
                            ok: false,
                            data: null,
                            envelope: null,
                            message: verification.message
                        });
                        return;
                    }
                    
                    const envelopeRaw = JSON.stringify(body);
                    resolve({
                        ok: true,
                        data: verification.data,
                        envelope: envelopeRaw,
                        message: verification.message
                    });
                } catch (error) {
                    resolve({
                        ok: false,
                        data: null,
                        envelope: null,
                        message: 'invalid JSON response'
                    });
                }
            });
        });
        
        req.on('error', (error) => {
            resolve({
                ok: false,
                data: null,
                envelope: null,
                message: `network error: ${error.constructor.name}`
            });
        });
        
        req.on('timeout', () => {
            req.destroy();
            resolve({
                ok: false,
                data: null,
                envelope: null,
                message: 'request timeout'
            });
        });
        
        req.write(postData);
        req.end();
    });
}

async function activateWithServer(licenseKey, activatedBy = 'web') {
    licenseKey = (licenseKey || '').trim();
    if (!licenseKey) {
        return { success: false, message: 'License key is required.' };
    }
    
    const machineId = await getMachineId();
    
    // CHECK: If this license key is already activated on this machine, just revalidate
    const currentState = await getState();
    if (currentState && currentState.key_blob && currentState.status === 'active') {
        const storedKey = decryptKey(currentState.key_blob, machineId);
        if (storedKey === licenseKey) {
            // Same key already activated on this machine - just revalidate
            logger.info('[License] Same license key already activated on this machine - revalidating');
            return await revalidateWithServer();
        }
    }
    
    // NEW license - proceed with activation
    const hardwareFingerprint = await generateHardwareFingerprint();
    const body = await buildRequest(licenseKey, machineId, hardwareFingerprint);
    const result = await makeRequest('/api/v1/activate', body);
    const nowIso = utcNow();
    
    if (!result.ok) {
        logger.warn('activate failed:', result.message);
        await updateState({
            last_check_at: nowIso,
            last_error: result.message.substring(0, 255)
        });
        return { success: false, message: `Could not validate license (${result.message}).` };
    }
    
    const status = result.data.status;
    if (status !== 'active') {
        await updateState({
            status: status,
            last_check_at: nowIso,
            last_error: (result.data.message || status || 'invalid').substring(0, 255),
            cached_envelope: null
        });
        return { success: false, message: result.data.message || status || 'invalid' };
    }
    
    // Success - persist hardware fingerprint + obfuscated key + cached signed envelope
    const cacheIntegrityCheck = sha256(result.envelope + machineId);
    await updateState({
        status: 'active',
        hardware_fingerprint: hardwareFingerprint,
        usage_type: result.data.usage_type,
        max_activations: result.data.max_activations,
        owner: result.data.owner,
        expires_at: result.data.expires_at,
        last_check_at: nowIso,
        last_success_at: nowIso,
        last_error: null,
        failure_count: 0,
        activation_failures: 0,
        activated_at: nowIso,
        activated_by: activatedBy,
        server_url: getServerUrl(),
        key_blob: encryptKey(licenseKey, machineId),
        cached_envelope: result.envelope,
        cache_integrity_check: cacheIntegrityCheck
    });
    
    logger.info('License activated successfully (cryptographically verified + hardware bound)');
    return { success: true, message: 'License activated successfully!' };
}

async function revalidateWithServer() {
    const state = await getState();
    if (!state) {
        return { success: false, message: 'no state', data: {} };
    }
    
    const key = decryptKey(state.key_blob, state.machine_id);
    if (!key) {
        return { success: false, message: 'no stored key', data: {} };
    }
    
    // Regenerate hardware fingerprint for validation
    const hardwareFingerprint = await generateHardwareFingerprint();
    
    const body = await buildRequest(key, state.machine_id, hardwareFingerprint);
    const result = await makeRequest('/api/v1/validate', body);
    const nowIso = utcNow();
    
    // Server unreachable or error
    if (!result.ok) {
        logger.error(`License validation failed: ${result.message}`);
        await updateState({
            last_check_at: nowIso,
            last_error: result.message.substring(0, 255),
            status: 'deactivated',
            cached_envelope: null,
            cache_integrity_check: null
        });
        return { success: false, message: result.message, data: {} };
    }
    
    const status = result.data.status;
    if (status === 'active') {
        const newCacheIntegrityCheck = sha256(result.envelope + state.machine_id);
        await updateState({
            status: 'active',
            hardware_fingerprint: hardwareFingerprint,
            usage_type: result.data.usage_type,
            max_activations: result.data.max_activations,
            owner: result.data.owner,
            expires_at: result.data.expires_at,
            last_check_at: nowIso,
            last_success_at: nowIso,
            last_error: null,
            cached_envelope: result.envelope,
            cache_integrity_check: newCacheIntegrityCheck
        });
        logger.info('✓ License validated by server - Status: ACTIVE');
        return { success: true, message: 'active', data: result.data };
    }
    
    // Server said license is not active - deactivate
    const message = result.data.message || status || 'invalid';
    await updateState({
        status: status,
        last_check_at: nowIso,
        last_error: message.substring(0, 255),
        cached_envelope: null,
        cache_integrity_check: null
    });
    logger.warn('License deactivated by server:', message);
    return { success: false, message, data: result.data };
}

// Authoritative activation check
// Simple check: just verify the license key blob exists
async function isActivated() {
    // Anniversary Edition - license check disabled
    logger.info('[License] Anniversary Edition - always activated');
    return true;
}

async function getSignedEnvelope() {
    const state = await getState();
    if (!state) return null;
    
    const verification = await verifyCachedEnvelope(
        state.cached_envelope,
        state.machine_id
    );
    
    return verification.ok ? verification.data : null;
}

async function getStatusInfo() {
    const state = await getState();
    if (!state) return { activated: false };
    
    const info = { ...state };
    delete info.key_blob;
    delete info.cached_envelope;
    info.activated = await isActivated();
    
    return info;
}

// Background revalidation - DISABLED (offline mode removed)
// License validation now happens synchronously in app.js every 5 minutes

function startBackgroundRevalidation() {
    // No-op function kept for backwards compatibility
    logger.debug('Background revalidation thread disabled (offline mode removed)');
}

// Middleware/decorator for route protection
function requiresLicense(fallback = null) {
    // Anniversary Edition - always allow access
    return function(req, res, next) {
        next();
    };
}

// Backwards-compat wrappers
async function activateWithServerWrapped(licenseKey, activatedBy = 'web') {
    return await activateWithServer(licenseKey, activatedBy);
}

async function deactivateLocal(reason = '') {
    await updateState({
        cached_envelope: null,
        last_error: reason ? reason.substring(0, 255) : null,
        last_check_at: utcNow()
    });
}

// Express middleware integration
function initLicenseMiddleware(app) {
    app.use('/api/license', async (req, res, next) => {
        try {
            await initLicenseStorage();
            next();
        } catch (error) {
            logger.error('Failed to initialize license storage:', error);
            res.status(500).json({ error: 'License system initialization failed' });
        }
    });
    
    app.get('/api/license/status', async (req, res) => {
        try {
            const status = await getStatusInfo();
            res.json(status);
        } catch (error) {
            logger.error('Error getting license status:', error);
            res.status(500).json({ error: 'Failed to get license status' });
        }
    });
    
    app.post('/api/license/activate', async (req, res) => {
        try {
            const { license_key, activated_by } = req.body;
            const result = await activateWithServer(license_key, activated_by);
            
            if (result.success) {
                res.json({ success: true, message: result.message });
            } else {
                res.status(400).json({ success: false, message: result.message });
            }
        } catch (error) {
            logger.error('Error activating license:', error);
            res.status(500).json({ error: 'Failed to activate license' });
        }
    });
    
    app.post('/api/license/deactivate', async (req, res) => {
        try {
            const { reason } = req.body;
            await deactivateLocal(reason);
            res.json({ success: true, message: 'License deactivated' });
        } catch (error) {
            logger.error('Error deactivating license:', error);
            res.status(500).json({ error: 'Failed to deactivate license' });
        }
    });
}

module.exports = {
    LICENSE_SERVER_URL,
    EMBEDDED_PUB_KEY_PEM,
    RECHECK_INTERVAL,
    MAX_ENVELOPE_AGE,
    initLicenseStorage,
    getMachineId,
    isActivated,
    getSignedEnvelope,
    getStatusInfo,
    getState,
    updateState,
    decryptKey,
    encryptKey,
    verifySignedResponse,
    activateWithServer,
    activateWithServerWrapped,
    revalidateWithServer,
    deactivateLocal,
    startBackgroundRevalidation,
    requiresLicense,
    getPublicKeyFingerprint,
    getServerUrl,
    initLicenseMiddleware,
    attemptLicenseRecovery
};