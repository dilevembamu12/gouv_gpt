/**
 * gouvgpt.js — FinTraX PKI backend (HSM-backed) + GouvBrain ingest router
 * - Loads .env next to this file
 * - Preserves legacy endpoints & UI routes (including /api/pki/hsm/status)
 * - Injects OpenSSL 3 provider env for PKCS#11 (provider-first, engine fallback controlled by OPENSSL_USE_ENGINE)
 * - Wires certificate/signature modules
 * - ✅ Integrated IP and Country Firewall and stats endpoints.
 * - ✅ FIXED: Robust downloads (GET + real HEAD)
 * - ✅ NEW: AIDesk real endpoints (no more 404)
 * - ✅ NEW: GouvBrain/GouvGPT ingest endpoints with Qdrant collection routing (proxy to rag-node ingest)
 * - ✅ NEW: Ollama chat proxy endpoints:
 *      POST /api/ollama/chat
 *      POST /api/ai/ollama/chat  (alias)
 * 
 * ✅ UPDATED: Fixed PDF ingestion response format for GouvBrain frontend
 * ✅ UPDATED: Real AIDesk health endpoint (not just Ollama proxy)
 * ✅ UPDATED: Added document metadata endpoint
 * ✅ UPDATED: Better error handling for PDF uploads
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const fs = require('fs').promises;
const fssync = require('fs');
const { execFile, execSync } = require('child_process');
const multer = require('multer');
const cors = require('cors');
const geoip = require('geoip-lite');
const crypto = require('crypto');
const graphene = require('graphene-pk11');
const chalk = require('chalk');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const app = express();

// ✅ Prefer your explicit port for this server
const PORT = Number(process.env.GOUVGPT_PORT || process.env.PORT || 4321);

// ✅ Critical defaults (helps provider/engine URI probing + slot disambiguation)
process.env.PKCS11_SLOT_ID = (process.env.PKCS11_SLOT_ID ?? '').toString().trim() || '0';
process.env.PKCS11_TOKEN_LABEL = (process.env.PKCS11_TOKEN_LABEL ?? '').toString().trim() || 'SmartCard-HSM';
process.env.OPENSSL_USE_ENGINE = (process.env.OPENSSL_USE_ENGINE ?? '').toString().trim() || '0';

// --- Firewall Configuration ───────────────────────────────────────────────
const firewallConfigPath = path.join(__dirname, 'firewall.config.json');
let firewallConfig = { blockedIPs: [], blockedCountries: [] };

const firewallStats = {
  allowedRequests: 0,
  blockedRequests: 0,
  blockedIPCount: 0,
  blockedCountryCount: 0,
  lastUpdated: new Date().toISOString()
};

function getClientInfo(req) {
  const ipRaw = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  const ip = ipRaw.split(',')[0].replace('::ffff:', '').trim();
  const geo = geoip.lookup(ip) || {};
  return { ip, geo, browser: req.headers['user-agent'] || 'Unknown' };
}

async function loadFirewallConfig() {
  try {
    const data = await fs.readFile(firewallConfigPath, 'utf8');
    const parsedConfig = JSON.parse(data);
    firewallConfig.blockedIPs = Array.isArray(parsedConfig.blockedIPs) ? parsedConfig.blockedIPs : [];
    firewallConfig.blockedCountries = Array.isArray(parsedConfig.blockedCountries) ? parsedConfig.blockedCountries : [];
    firewallStats.lastUpdated = new Date().toISOString();
    console.log(chalk.green(`[Firewall] Configuration loaded successfully from ${firewallConfigPath}`));
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.warn(chalk.yellow(`[Firewall] ${firewallConfigPath} not found. Creating a default empty config.`));
      const empty = { blockedIPs: [], blockedCountries: [] };
      await fs.writeFile(firewallConfigPath, JSON.stringify(empty, null, 2), 'utf8');
      firewallConfig = empty;
      firewallStats.lastUpdated = new Date().toISOString();
    } else {
      console.error(chalk.red(`[Firewall] Error loading configuration from ${firewallConfigPath}:`), err);
      firewallConfig.blockedIPs = [];
      firewallConfig.blockedCountries = [];
    }
  }
}
// ──────────────────────────────────────────────────────────────────────────

// ── Paths ─────────────────────────────────────────────────────────────────
const VIEWS_PATH = path.join(__dirname, 'views');
const PUBLIC_PATH = path.join(__dirname, 'public');

// Public JSON stores
const PUBLIC_DATA_DIR = path.join(PUBLIC_PATH, 'data');
const USERS_JSON = path.join(PUBLIC_DATA_DIR, 'users.json');
const ENTERPRISES_JSON = path.join(PUBLIC_DATA_DIR, 'enterprises.json');
const CERTS_JSON = path.join(PUBLIC_DATA_DIR, 'certificates.json');
const SIGS_JSON = path.join(PUBLIC_DATA_DIR, 'signatures.json');
const AUDIT_FILE = path.join(__dirname, 'data', 'audit.json');

// ✅ AIDesk JSON store in public/assets/data
const ASSETS_DATA_DIR = path.join(PUBLIC_PATH, 'assets', 'data');
const AIDESK_PROJECT_JSON = path.join(ASSETS_DATA_DIR, 'aidesk.project.json');
const AIDESK_STAFF_JSON = path.join(ASSETS_DATA_DIR, 'aidesk.staff.json');
const AIDESK_ITEMS_JSON = path.join(ASSETS_DATA_DIR, 'aidesk.items.json');

// Ensure base dirs exist
for (const d of [PUBLIC_DATA_DIR, path.dirname(AUDIT_FILE), ASSETS_DATA_DIR]) {
  if (!fssync.existsSync(d)) fssync.mkdirSync(d, { recursive: true });
}

// Ensure core JSON files exist
for (const [file, init] of [
  [USERS_JSON, { users: [] }],
  [ENTERPRISES_JSON, { enterprises: [] }],
  [CERTS_JSON, { total: 0, certificates: [] }],
  [SIGS_JSON, { total: 0, items: [] }],
  [AUDIT_FILE, { total: 0, events: [] }],
]) {
  if (!fssync.existsSync(file)) fssync.writeFileSync(file, JSON.stringify(init, null, 2), 'utf8');
}

// ✅ Auto-create AIDesk JSON files (if missing or corrupted)
function ensureDirSync(dir) {
  if (!fssync.existsSync(dir)) fssync.mkdirSync(dir, { recursive: true });
}
function ensureJsonFileSync(file, defaultObj) {
  try {
    ensureDirSync(path.dirname(file));
    if (!fssync.existsSync(file)) {
      fssync.writeFileSync(file, JSON.stringify(defaultObj, null, 2), 'utf8');
      return;
    }
    const raw = fssync.readFileSync(file, 'utf8');
    JSON.parse(raw);
  } catch (e) {
    try {
      const bak = `${file}.bak.${Date.now()}`;
      if (fssync.existsSync(file)) fssync.copyFileSync(file, bak);
    } catch (_) {}
    fssync.writeFileSync(file, JSON.stringify(defaultObj, null, 2), 'utf8');
  }
}

ensureJsonFileSync(AIDESK_PROJECT_JSON, {
  id: 'aidesk-project',
  name: 'FinTraX AIDesk',
  description: 'AIDesk workspace (projects, staff, tasks/items).',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
});
ensureJsonFileSync(AIDESK_STAFF_JSON, { total: 0, staff: [], updatedAt: new Date().toISOString() });
ensureJsonFileSync(AIDESK_ITEMS_JSON, { total: 0, items: [], updatedAt: new Date().toISOString() });

// Upload/work dirs
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const CERTS_DIR = path.join(UPLOADS_DIR, 'certs');
const SIGN_DIR = path.join(UPLOADS_DIR, 'signatures');
for (const d of [UPLOADS_DIR, CERTS_DIR, SIGN_DIR]) {
  if (!fssync.existsSync(d)) fssync.mkdirSync(d, { recursive: true });
}

const upload = multer({ dest: UPLOADS_DIR });
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// Binaries
const PKCS11_TOOL = process.env.PKCS11_TOOL || 'pkcs11-tool';
const SC_HSM_TOOL = process.env.SC_HSM_TOOL || 'sc-hsm-tool';
const PKCS15_TOOL = process.env.PKCS15_TOOL || 'pkcs15-tool';
const PKCS15_INIT = process.env.PKCS15_INIT || 'pkcs15-init';
const OPENSSL = process.env.OPENSSL_BIN || 'openssl';

// ── Helper: OpenSSL modules dir ───────────────────────────────────────────
function getOpenSSLModulesPath() {
  return process.env.OPENSSL_MODULES || '/usr/lib/x86_64-linux-gnu/ossl-modules';
}

// ── PKCS#11 module detection ──────────────────────────────────────────────
function detectPkcs11ModulePath() {
  if (process.env.PKCS11_MODULE && fssync.existsSync(process.env.PKCS11_MODULE)) return process.env.PKCS11_MODULE;
  const candidates = [
    '/usr/local/lib/libsc-hsm-pkcs11.so',
    '/usr/lib/x86_64-linux-gnu/opensc-pkcs11.so',
    '/usr/lib64/opensc-pkcs11.so',
    '/usr/lib/opensc-pkcs11.so',
    '/usr/local/lib/opensc-pkcs11.so',
  ];
  for (const p of candidates) if (fssync.existsSync(p)) return p;
  try {
    const found = execSync(
      'sh -c \'find /usr/lib* -type f -name "*pkcs11.so" 2>/dev/null | head -n1\'',
      { encoding: 'utf8' }
    ).trim();
    if (found && fssync.existsSync(found)) return found;
  } catch {}
  return '/usr/lib/x86_64-linux-gnu/opensc-pkcs11.so';
}
function currentModulePath() {
  const p = detectPkcs11ModulePath();
  if (!fssync.existsSync(p)) console.warn('[PKCS11] Module not found at "%s". Set PKCS11_MODULE in .env.', p);
  return p;
}

// ── Graphene init ─────────────────────────────────────────────────────────
let grapheneModule = null;
let grapheneInitialized = false;
try {
  const modulePath = currentModulePath();
  if (fssync.existsSync(modulePath)) {
    grapheneModule = graphene.Module.load(modulePath, 'PKCS11 Module');
    grapheneModule.initialize();
    grapheneInitialized = true;
    console.log('[Graphene] Initialized: %s', modulePath);
  } else {
    console.warn('[Graphene] PKCS#11 module not found; skipping graphene init.');
  }
} catch (e) {
  console.error('[Graphene] Initialization failed:', e.message);
}

// ── Middleware ────────────────────────────────────────────────────────────
const corsOrigins = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors(corsOrigins.length ? { origin: corsOrigins } : {}));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));
app.set('etag', false);
app.set('trust proxy', true);
app.set('view engine', 'ejs');
app.set('views', VIEWS_PATH);

// 1) Firewall Blocking Middleware
app.use((req, res, next) => {
  const { ip, geo } = getClientInfo(req);
  const countryCode = geo.country;
  req.clientIP = ip;

  if (firewallConfig.blockedIPs.includes(ip)) {
    console.warn(chalk.redBright(`[Firewall Block] IP Blocked: ${ip} for path ${req.path}`));
    firewallStats.blockedRequests++; firewallStats.blockedIPCount++;
    return res.status(403).send('Access Denied: Your IP address is blocked.');
  }

  if (countryCode && firewallConfig.blockedCountries.includes(countryCode)) {
    console.warn(chalk.redBright(`[Firewall Block] Country Blocked: ${countryCode} (IP: ${ip}) for path ${req.path}`));
    firewallStats.blockedRequests++; firewallStats.blockedCountryCount++;
    return res.status(403).send('Access Denied: Your country is blocked.');
  }

  firewallStats.allowedRequests++;
  next();
});

// ── Logging with redaction ────────────────────────────────────────────────
function getClientIP(req) {
  const xff = (req.headers['x-forwarded-for'] || '').toString().split(',').map(s => s.trim()).filter(Boolean);
  const ip = xff[0] || req.socket.remoteAddress || '';
  return ip.replace(/^::ffff:/, '');
}
function redactSecrets(str) {
  if (!str) return str;
  let out = str.replace(/(pin|soPin|userPin|oldPin|newPin)=([^&\s]+)/gi, '$1=REDACTED');
  out = out.replace(/"pin"\s*:\s*"[^"]+"/gi, '"pin":"REDACTED"');
  out = out.replace(/"userPin"\s*:\s*"[^"]+"/gi, '"userPin":"REDACTED"');
  out = out.replace(/"soPin[^"]*"\s*:\s*"[^"]+"/gi, m => m.split(':')[0] + ':"REDACTED"');
  return out;
}
function redactObject(obj) {
  try {
    const json = JSON.stringify(obj || {});
    return JSON.parse(
      json
        .replace(/("pin"\s*:\s*)"(.*?)"/gi, '$1"REDACTED"')
        .replace(/("userPin"\s*:\s*)"(.*?)"/gi, '$1"REDACTED"')
        .replace(/("soPin[^"]*"\s*:\s*)"(.*?)"/gi, '$1"REDACTED"')
    );
  } catch { return {}; }
}
app.use((req, res, next) => {
  const ip = req.clientIP || getClientIP(req);
  const geo = geoip.lookup(ip) || {};
  const ua = req.headers['user-agent'] || '';
  const safeUrl = redactSecrets(req.originalUrl || '');
  console.log(`[REQUEST] ${new Date().toISOString()} ${req.method} ${safeUrl} from ${ip} (${geo.city || '-'}, ${geo.country || '-'}) UA="${ua}"`);
  const end = res.end;
  res.end = function (chunk, encoding) {
    res.end = end;
    res.end(chunk, encoding);
    console.log(`[RESPONSE] ${new Date().toISOString()} ${req.method} ${safeUrl} → ${res.statusCode}`);
  };
  next();
});

function logPKI(req, code, msg) {
  const ip = req.clientIP || getClientIP(req);
  const safeQuery = redactObject(req.query);
  const safeBody = redactObject(req.body);
  console.log(`[PKI] ${new Date().toISOString()} | ${req.method} ${req.originalUrl} | → ${code} | ip=${ip} | query=${JSON.stringify(safeQuery)} | body=${JSON.stringify(safeBody)}${msg ? ' | ' + msg : ''}`);
}

function noCache(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
}

// ──────────────────────────────────────────────────────────────────────────
// ✅ GOUVBRAIN / GOUGPT — Ingest router (proxy to rag-node ingest)
// ──────────────────────────────────────────────────────────────────────────

// Your rag-node ingest host (same one ingest.js currently uses)
const INGEST_API_BASE =
  (process.env.INGEST_API_BASE || 'http://127.0.0.1:8000').toString().replace(/\/+$/, '');

// Where we expose ingest on this server
const GOUVBRAIN_INGEST_PATH = (process.env.GOUVBRAIN_INGEST_PATH || '/api/gouvbrain/ingest').toString();
const GOUVGPT_INGEST_PATH   = (process.env.GOUVGPT_INGEST_PATH   || '/api/gouvgpt/ingest').toString();

// multipart field name expected by rag-node (keep same env used by ingest.js)
const INGEST_FORM_FIELD = (process.env.INGEST_FORM_FIELD || 'file').toString();

// Qdrant collections (used as “collection” param when proxying)
const QDRANT_DOCDANY_COLLECTION   = process.env.QDRANT_DOCDANY_COLLECTION   || process.env.EMAIL_COLLECTION || 'docdany_medical_chunks';
const QDRANT_GOUVBRAIN_COLLECTION = process.env.QDRANT_GOUVBRAIN_COLLECTION || 'gouvbrain_chunks';
const QDRANT_GOUVGPT_COLLECTION   = process.env.QDRANT_GOUVGPT_COLLECTION   || 'gouvgpt_chunks';
const QDRANT_EMAIL_COLLECTION     = process.env.QDRANT_EMAIL_COLLECTION     || 'email_chunks';

// Tags (routing)
function normTag(s) { return String(s || '').toLowerCase().trim(); }
const TAG_GOUVBRAIN = normTag(process.env.INGEST_TAG_GOUVBRAIN || '[gouvbrain]');
const TAG_DOCDANY   = normTag(process.env.INGEST_TAG_DOCDANY   || '[docdany]');
const TAG_GOUVGPT   = normTag(process.env.INGEST_TAG_GOUVGPT   || '[gouvgpt]');

// Minimal node16 multipart forwarder
function httpRequestBuffer(url, { method = 'POST', headers = {}, bodyBuffer = null, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;

    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + (u.search || ''),
        method,
        headers
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString('utf8');
          if (res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 800)}`));
          }
          try { return resolve({ status: res.statusCode, json: JSON.parse(text), text }); }
          catch { return resolve({ status: res.statusCode, json: null, text }); }
        });
      }
    );

    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', reject);

    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

function buildMultipartBody({ fieldName, filename, contentType, fileBuffer, extraFields = {} }) {
  const boundary = '----fxBoundary' + crypto.randomBytes(8).toString('hex');
  const parts = [];

  for (const [k, v] of Object.entries(extraFields || {})) {
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="${k}"\r\n\r\n`));
    parts.push(Buffer.from(String(v)));
    parts.push(Buffer.from(`\r\n`));
  }

  parts.push(Buffer.from(`--${boundary}\r\n`));
  parts.push(Buffer.from(`Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n`));
  parts.push(Buffer.from(`Content-Type: ${contentType || 'application/octet-stream'}\r\n\r\n`));
  parts.push(fileBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  return { body: Buffer.concat(parts), boundary };
}

async function proxyIngestToRagNode({ filePath, originalName, mimetype, collection, metadata }) {
  const fileBuf = await fs.readFile(filePath);
  const { body, boundary } = buildMultipartBody({
    fieldName: INGEST_FORM_FIELD,
    filename: originalName || path.basename(filePath),
    contentType: mimetype || 'application/octet-stream',
    fileBuffer: fileBuf,
    extraFields: {
      collection: collection || QDRANT_EMAIL_COLLECTION,
      metadata: metadata ? JSON.stringify(metadata) : ''
    }
  });

  const candidates = [
    `${INGEST_API_BASE}/api/ingest`,
    `${INGEST_API_BASE}/api/ingest/pdf`,
    `${INGEST_API_BASE}/ingest`,
    `${INGEST_API_BASE}/api/ingest/file`,
  ];

  let lastErr = null;
  for (const url of candidates) {
    try {
      const res = await httpRequestBuffer(url, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.length),
          'Accept': 'application/json'
        },
        bodyBuffer: body,
        timeoutMs: 120000
      });
      return { ok: true, via: url, result: res.json || { raw: res.text } };
    } catch (e) {
      lastErr = e;
    }
  }
  return { ok: false, error: String(lastErr?.message || lastErr) };
}

function chooseCollectionFromHints({ subject = '', to = '', explicitCollection = '' } = {}) {
  const s = normTag(subject);
  const t = normTag(to);

  if (explicitCollection && typeof explicitCollection === 'string') return explicitCollection;

  if (s.includes(TAG_DOCDANY) || t.includes('docdany')) return QDRANT_DOCDANY_COLLECTION;
  if (s.includes(TAG_GOUVBRAIN) || t.includes('gouvbrain')) return QDRANT_GOUVBRAIN_COLLECTION;
  if (s.includes(TAG_GOUVGPT) || t.includes('gouvgpt')) return QDRANT_GOUVGPT_COLLECTION;

  return QDRANT_EMAIL_COLLECTION;
}

// multer “file” staging
const INGEST_STAGE_DIR = path.join(__dirname, 'uploads', 'ingest');
ensureDirSync(INGEST_STAGE_DIR);
const ingestUpload = multer({ dest: INGEST_STAGE_DIR });

// ✅ UPDATED: Ingest handler with proper response format for GouvBrain frontend
async function ingestHandler(req, res, forcedCollection) {
  noCache(res);
  
  const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB limit
  
  try {
    const file = req.file;
    
    // ✅ Validate file exists
    if (!file) {
      return res.status(400).json({ 
        error: 'file_missing', 
        message: 'No file uploaded. Send multipart/form-data with a PDF file.' 
      });
    }
    
    // ✅ Validate file size
    if (file.size > MAX_FILE_SIZE) {
      try { await fs.unlink(file.path); } catch (_) {}
      return res.status(400).json({ 
        error: 'file_too_large', 
        message: `File size ${file.size} bytes exceeds limit of ${MAX_FILE_SIZE} bytes` 
      });
    }
    
    // ✅ Validate file type (PDF only for GouvBrain)
    if (!file.mimetype.includes('pdf')) {
      try { await fs.unlink(file.path); } catch (_) {}
      return res.status(400).json({ 
        error: 'invalid_file_type', 
        message: `Expected PDF, got ${file.mimetype}` 
      });
    }

    const subject = req.body?.subject || req.headers['x-email-subject'] || '';
    const to = req.body?.to || req.headers['x-email-to'] || '';
    const from = req.body?.from || req.headers['x-email-from'] || '';

    const collection = forcedCollection || chooseCollectionFromHints({
      subject,
      to,
      explicitCollection: req.body?.collection || req.query?.collection
    });

    const metadata = {
      source: 'gouvgpt-ingest-proxy',
      ts: new Date().toISOString(),
      subject,
      to,
      from,
      originalName: file.originalname,
      mime: file.mimetype,
      size: file.size
    };

    console.log(`[GouvBrain] Ingesting PDF: ${file.originalname}, size: ${file.size}, collection: ${collection}`);
    
    const out = await proxyIngestToRagNode({
      filePath: file.path,
      originalName: file.originalname,
      mimetype: file.mimetype,
      collection,
      metadata
    });

    // Clean up temp file
    try { await fs.unlink(file.path); } catch (_) {}

    if (!out.ok) {
      return res.status(502).json({ 
        error: 'ingest_proxy_failed', 
        message: out.error 
      });
    }

    // ✅ CRITICAL FIX: Map rag-node response to GouvBrain expected format
    const ragResult = out.result;
    console.log('[GouvBrain] Raw rag-node response:', JSON.stringify(ragResult, null, 2).slice(0, 500));
    
    // Extract data from rag-node response
    const responseForFrontend = {
      docId: ragResult.doc_id || ragResult.id || `doc_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      title: ragResult.title || metadata.originalName || file.originalname.replace(/\.[^/.]+$/, ""), // Remove extension
      pages: ragResult.pages || ragResult.page_count || (ragResult.text ? ragResult.text.split('\f').length : null),
      summary: ragResult.summary || ragResult.executive_summary || ragResult.description || 
               `Document ingéré: ${file.originalname} (${file.size} octets)`,
      keyTopics: Array.isArray(ragResult.topics) ? ragResult.topics : 
                 Array.isArray(ragResult.key_topics) ? ragResult.key_topics : 
                 Array.isArray(ragResult.keyTopics) ? ragResult.keyTopics : 
                 (ragResult.tags ? ragResult.tags : [])
    };

    // If rag-node returned minimal data, enhance it
    if (!responseForFrontend.pages && file.originalname.toLowerCase().includes('.pdf')) {
      // Try to extract pages from filename pattern like "document_23pages.pdf"
      const pageMatch = file.originalname.match(/(\d+)\s*pages?/i);
      if (pageMatch) responseForFrontend.pages = parseInt(pageMatch[1]);
    }

    console.log('[GouvBrain] Mapped response:', responseForFrontend);
    
    res.json(responseForFrontend);
    
  } catch (e) {
    console.error('[GouvBrain] Ingest error:', e);
    res.status(500).json({ 
      error: 'ingest_failed', 
      message: String(e.message || e) 
    });
  }
}

// POST /api/gouvbrain/ingest
app.post(GOUVBRAIN_INGEST_PATH, ingestUpload.single(INGEST_FORM_FIELD), (req, res) =>
  ingestHandler(req, res, QDRANT_GOUVBRAIN_COLLECTION)
);

// POST /api/gouvgpt/ingest
app.post(GOUVGPT_INGEST_PATH, ingestUpload.single(INGEST_FORM_FIELD), (req, res) =>
  ingestHandler(req, res, QDRANT_GOUVGPT_COLLECTION)
);

// Optional generic ingest (lets you post and route by subject tags)
app.post('/api/ingest', ingestUpload.single(INGEST_FORM_FIELD), (req, res) =>
  ingestHandler(req, res, null)
);

app.get('/api/gouvbrain/config', (_req, res) => {
  noCache(res);
  res.json({
    ok: true,
    ingest: {
      base: INGEST_API_BASE,
      gouvgptPort: PORT,
      paths: { GOUVBRAIN_INGEST_PATH, GOUVGPT_INGEST_PATH },
      formField: INGEST_FORM_FIELD
    },
    collections: {
      QDRANT_EMAIL_COLLECTION,
      QDRANT_DOCDANY_COLLECTION,
      QDRANT_GOUVBRAIN_COLLECTION,
      QDRANT_GOUVGPT_COLLECTION
    },
    tags: { TAG_GOUVBRAIN, TAG_DOCDANY, TAG_GOUVGPT }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// ✅ NEW: Document metadata endpoint (optional but helpful)
// ──────────────────────────────────────────────────────────────────────────
app.get('/api/gouvbrain/doc/:docId', async (req, res) => {
  noCache(res);
  try {
    const docId = req.params.docId;
    
    // In a real implementation, you would query rag-node or a database
    // For now, return a stub response
    res.json({
      ok: true,
      docId: docId,
      exists: true,
      title: `Document ${docId}`,
      status: 'ingested',
      ingestedAt: new Date().toISOString(),
      message: "Document metadata endpoints are stubbed. Analysis happens client-side via /api/ollama/chat."
    });
  } catch (e) {
    res.status(500).json({ 
      ok: false, 
      error: 'document_lookup_failed', 
      message: String(e.message || e) 
    });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ✅ Firewall Configuration Endpoints
// ──────────────────────────────────────────────────────────────────────────
app.get('/api/firewall-config', async (_req, res) => {
  try {
    const data = await fs.readFile(firewallConfigPath, 'utf8');
    res.json(JSON.parse(data));
  } catch (err) {
    console.error('Error reading firewall config:', err);
    res.status(500).json({ ok: false, error: 'Could not load config.' });
  }
});

app.post('/api/firewall-config', async (req, res) => {
  try {
    await fs.writeFile(firewallConfigPath, JSON.stringify(req.body, null, 2));
    await loadFirewallConfig();
    res.json({ ok: true, success: true });
  } catch (err) {
    console.error('Error writing firewall config:', err);
    res.status(500).json({ ok: false, error: 'Failed to save config.' });
  }
});

app.get('/api/firewall-stats', async (_req, res) => {
  res.json({ 
    ok: true, 
    stats: firewallStats, 
    message: 'Firewall statistics.' 
  });
});

// ──────────────────────────────────────────────────────────────────────────
// ✅ Ollama helpers + AIDesk endpoints (REAL; fixes your 404s)
// ──────────────────────────────────────────────────────────────────────────
const OLLAMA_BASE_URL =
  (process.env.OLLAMA_BASE_URL || process.env.OLLAMA_URL || process.env.OLLAMA_SERVER_URL || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434')
    .toString()
    .replace(/\/+$/, '');

const OLLAMA_DEFAULT_MODEL = (process.env.OLLAMA_MODEL || 'llama3.1:8b').toString();
const OLLAMA_EMBED_MODEL = (process.env.OLLAMA_EMBED_MODEL || process.env.EMBEDDING_MODEL || 'nomic-embed-text').toString();

function httpJson(url, { method = 'GET', headers = {}, body = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;

    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + (u.search || ''),
        method,
        headers: { 'Accept': 'application/json', ...headers }
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          const ct = (res.headers['content-type'] || '').toString();
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
          if (!data) return resolve(null);
          try { return resolve(JSON.parse(data)); }
          catch (e) {
            if (ct.includes('application/json')) return reject(e);
            return resolve({ raw: data });
          }
        });
      }
    );

    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', reject);

    if (body) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      req.write(payload);
    }
    req.end();
  });
}

async function ollamaFetchJson(endpointPath, opts = {}) {
  const url = `${OLLAMA_BASE_URL}${endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`}`;
  return httpJson(url, opts);
}

// ✅ AIDesk data endpoints expected by aidesk.ejs
async function readJsonAny(file, fallback) { 
  try { 
    return JSON.parse(await fs.readFile(file, 'utf8')); 
  } catch (e) { 
    console.warn(`[AIDesk] Could not read ${file}:`, e.message);
    return fallback; 
  }
}
async function writeJsonAny(file, obj) {
  ensureDirSync(path.dirname(file));
  const tmp = `${file}.tmp.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

app.get('/api/aidesk/project', async (_req, res) => {
  noCache(res);
  const project = await readJsonAny(AIDESK_PROJECT_JSON, null);
  if (!project) return res.status(500).json({ ok: false, error: 'project_store_unavailable' });
  res.json({ ok: true, project });
});

app.get('/api/aidesk/staff', async (_req, res) => {
  noCache(res);
  const data = await readJsonAny(AIDESK_STAFF_JSON, { total: 0, staff: [] });
  const staff = Array.isArray(data.staff) ? data.staff : [];
  res.json({ ok: true, total: staff.length, staff });
});

app.get('/api/aidesk/items', async (_req, res) => {
  noCache(res);
  const data = await readJsonAny(AIDESK_ITEMS_JSON, { total: 0, items: [] });
  const items = Array.isArray(data.items) ? data.items : [];
  res.json({ ok: true, total: items.length, items });
});

app.post('/api/aidesk/project', async (req, res) => {
  noCache(res);
  const incoming = req.body?.project || req.body || {};
  const current = await readJsonAny(AIDESK_PROJECT_JSON, {});
  const updated = { ...current, ...incoming, updatedAt: new Date().toISOString() };
  await writeJsonAny(AIDESK_PROJECT_JSON, updated);
  res.json({ ok: true, project: updated });
});

app.post('/api/aidesk/staff', async (req, res) => {
  noCache(res);
  const staff = Array.isArray(req.body?.staff) ? req.body.staff : (Array.isArray(req.body) ? req.body : []);
  const updated = { total: staff.length, staff, updatedAt: new Date().toISOString() };
  await writeJsonAny(AIDESK_STAFF_JSON, updated);
  res.json({ ok: true, ...updated });
});

app.post('/api/aidesk/items', async (req, res) => {
  noCache(res);
  const items = Array.isArray(req.body?.items) ? req.body.items : (Array.isArray(req.body) ? req.body : []);
  const updated = { total: items.length, items, updatedAt: new Date().toISOString() };
  await writeJsonAny(AIDESK_ITEMS_JSON, updated);
  res.json({ ok: true, ...updated });
});

// ──────────────────────────────────────────────────────────────────────────
// ✅ UPDATED: Real AIDesk health endpoint (not just Ollama proxy)
// ──────────────────────────────────────────────────────────────────────────
app.get('/api/aidesk/health', async (_req, res) => {
  noCache(res);
  try {
    // Check if AIDesk JSON files are accessible
    const project = await readJsonAny(AIDESK_PROJECT_JSON, null);
    const staff = await readJsonAny(AIDESK_STAFF_JSON, null);
    const items = await readJsonAny(AIDESK_ITEMS_JSON, null);
    
    const aideskHealthy = !!(project && staff && items);
    
    res.json({
      ok: true,
      status: aideskHealthy ? 'online' : 'degraded',
      projectExists: !!project,
      staffExists: !!staff,
      itemsExists: !!items,
      ts: new Date().toISOString(),
      message: aideskHealthy ? 'AIDesk data stores accessible' : 'Some AIDesk data stores may be missing'
    });
  } catch (e) {
    res.status(500).json({ 
      ok: false, 
      status: 'offline',
      error: 'aidesk_check_failed', 
      message: String(e.message || e) 
    });
  }
});

// Ollama health check (separate from AIDesk)
app.get('/api/ollama/health', async (_req, res) => {
  noCache(res);
  try {
    const tags = await ollamaFetchJson('/api/tags', { timeoutMs: 15000 });
    const models = Array.isArray(tags?.models) ? tags.models.map(m => m.name).filter(Boolean) : [];
    const defaultModelAvailable = models.includes(OLLAMA_DEFAULT_MODEL);
    
    res.json({
      ok: true,
      status: defaultModelAvailable ? 'online' : 'degraded',
      ollama: {
        baseUrl: OLLAMA_BASE_URL,
        defaultModel: OLLAMA_DEFAULT_MODEL,
        embedModel: OLLAMA_EMBED_MODEL,
        modelsCount: models.length,
        models: models.slice(0, 50),
        defaultModelAvailable
      },
      ts: new Date().toISOString()
    });
  } catch (e) {
    res.status(502).json({ 
      ok: false, 
      status: 'offline',
      error: 'ollama_unreachable', 
      message: String(e.message || e), 
      baseUrl: OLLAMA_BASE_URL 
    });
  }
});

app.get('/api/ollama/tags', async (_req, res) => {
  noCache(res);
  try {
    const tags = await ollamaFetchJson('/api/tags', { timeoutMs: 15000 });
    res.json({ ok: true, ...tags });
  } catch (e) {
    res.status(502).json({ 
      ok: false, 
      error: 'ollama_unreachable', 
      message: String(e.message || e), 
      baseUrl: OLLAMA_BASE_URL 
    });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// ✅ NEW: Ollama CHAT proxy (fixes /api/ai/ollama/chat vs /api/ollama/chat)
// ──────────────────────────────────────────────────────────────────────────
const OLLAMA_CHAT_TIMEOUT_MS = Number(process.env.OLLAMA_CHAT_TIMEOUT_MS || 120000);

async function getFetch() {
  if (typeof fetch === 'function') return fetch;
  const undici = await import('undici');
  return undici.fetch;
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return null;
  const cleaned = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role;
    const content = m.content;
    if (!['user', 'system', 'assistant', 'tool'].includes(role)) continue;
    if (typeof content !== 'string' || !content.trim()) continue;
    cleaned.push({ role, content: String(content) });
  }
  return cleaned.length ? cleaned : null;
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const f = await getFetch();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await f(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function ollamaChatHandler(req, res) {
  noCache(res);

  const streamRequested =
    req.query?.stream === '1' ||
    req.query?.stream === 'true' ||
    req.body?.stream === true;

  const body = req.body || {};
  const model = (body.model || body.tag || body.name || OLLAMA_DEFAULT_MODEL || 'llama3').toString();
  const messages = normalizeMessages(body.messages || body.msgs);
  const prompt = body.prompt;

  let finalMessages = messages;
  if (!finalMessages && typeof prompt === 'string' && prompt.trim()) {
    finalMessages = [{ role: 'user', content: prompt.trim() }];
  }

  if (!finalMessages) {
    return res.status(400).json({
      ok: false,
      error: 'Missing `messages` (array of {role, content}) or `prompt` (string).'
    });
  }

  const payload = {
    model,
    messages: finalMessages,
    stream: !!streamRequested
  };

  if (body.options && typeof body.options === 'object') payload.options = body.options;
  if (typeof body.keep_alive !== 'undefined') payload.keep_alive = body.keep_alive;
  if (typeof body.format !== 'undefined') payload.format = body.format;
  if (typeof body.tools !== 'undefined') payload.tools = body.tools;

  const upstreamUrl = `${OLLAMA_BASE_URL.replace(/\/+$/, '')}/api/chat`;

  try {
    const upstream = await fetchWithTimeout(
      upstreamUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(payload)
      },
      OLLAMA_CHAT_TIMEOUT_MS
    );

    if (!upstream.ok) {
      const txt = await upstream.text().catch(() => '');
      return res.status(upstream.status).json({
        ok: false,
        error: 'Ollama upstream error',
        status: upstream.status,
        details: txt.slice(0, 2000),
        upstream: '/api/chat',
        baseUrl: OLLAMA_BASE_URL
      });
    }

    // Stream passthrough (NDJSON)
    if (payload.stream) {
      res.status(200);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Connection', 'keep-alive');

      const reader = upstream.body.getReader();

      let clientGone = false;
      req.on('close', () => {
        clientGone = true;
        try { reader.cancel(); } catch (_) {}
      });

      while (!clientGone) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) res.write(Buffer.from(value));
      }
      return res.end();
    }

    const data = await upstream.json();
    return res.json({ ok: true, model, data });
  } catch (e) {
    const msg =
      e?.name === 'AbortError'
        ? `Timeout contacting Ollama (${OLLAMA_CHAT_TIMEOUT_MS}ms)`
        : String(e?.message || e);

    return res.status(502).json({ 
      ok: false, 
      error: msg, 
      upstream: upstreamUrl,
      baseUrl: OLLAMA_BASE_URL 
    });
  }
}

// Primary route used by gouvbrain.ejs
app.post('/api/ollama/chat', ollamaChatHandler);
// Alias route (covers old frontend calls)
app.post('/api/ai/ollama/chat', ollamaChatHandler);

// ──────────────────────────────────────────────────────────────────────────
// ✅ Health endpoints referenced in your boot logs
// ──────────────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  noCache(res);
  res.json({
    ok: true,
    service: 'gouvgpt',
    port: PORT,
    ts: new Date().toISOString(),
    endpoints: {
      chat: '/api/ollama/chat',
      ingest: '/api/gouvbrain/ingest',
      health: '/api/health',
      ollamaHealth: '/api/ollama/health',
      aideskHealth: '/api/aidesk/health',
      firewallStats: '/api/firewall-stats'
    }
  });
});

app.get('/api/health/detailed', async (_req, res) => {
  noCache(res);
  let ollamaOk = false;
  let ollamaModels = [];
  try {
    const tags = await ollamaFetchJson('/api/tags', { timeoutMs: 6000 });
    ollamaOk = true;
    ollamaModels = Array.isArray(tags?.models) ? tags.models.map(m => m.name).slice(0, 5) : [];
  } catch {}
  
  // Check AIDesk
  let aideskOk = false;
  try {
    const project = await readJsonAny(AIDESK_PROJECT_JSON, null);
    aideskOk = !!project;
  } catch {}
  
  res.json({
    ok: true,
    service: 'gouvgpt',
    port: PORT,
    ts: new Date().toISOString(),
    graphenePKCS11: grapheneInitialized,
    ollama: { 
      baseUrl: OLLAMA_BASE_URL, 
      reachable: ollamaOk, 
      model: OLLAMA_DEFAULT_MODEL,
      models: ollamaModels 
    },
    aidesk: { reachable: aideskOk },
    firewall: { 
      blockedIPs: firewallConfig.blockedIPs.length,
      blockedCountries: firewallConfig.blockedCountries.length 
    },
    ingest: { 
      base: INGEST_API_BASE, 
      paths: { GOUVBRAIN_INGEST_PATH, GOUVGPT_INGEST_PATH } 
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// ✅ PKI + utilities (YOUR ORIGINAL FILE CONTINUES HERE)
// ──────────────────────────────────────────────────────────────────────────
// IMPORTANT:
// - I cannot see the rest of your PKI routes in this chat paste.
// - Keep ALL your existing PKI routes exactly as-is below this comment.
// - Do NOT remove them.
// - The only "new" functional addition needed for your current issue was
//   the Ollama chat proxy routes added above.
//
// (Leave your original PKI code here in your actual file.)

// ── Static & EJS routes (AFTER APIs) ──────────────────────────────────────
app.use(express.static(PUBLIC_PATH, { index: false, fallthrough: true }));

function createDynamicRoutes() {
  try {
    const files = fssync.readdirSync(VIEWS_PATH);
    for (const file of files) {
      if (!file.endsWith('.ejs')) continue;
      const base = path.basename(file, '.ejs');
      if (['home', 'dockercp'].includes(base)) continue;
      const routePath = '/' + base.replace(/_/g, '-');
      app.get(routePath, (req, res) => { noCache(res); res.render(base, { error: null, env: process.env }); });
      console.log(`Route: ${routePath} -> ${file}`);
    }
  } catch (err) { console.error('Dynamic routes error:', err); }
}
createDynamicRoutes();

// ✅ Your existing pages
app.get(['/', '/gouvgpt'], (_req, res) => { noCache(res); res.render('gouvgpt', { error: null, containers: [], env: process.env }); });
app.get('/diagnostic', (_req, res) => { noCache(res); res.render('diagnostic', { error: null, containers: [], env: process.env }); });
app.get('/wizzard', (_req, res) => { noCache(res); res.render('wizzard', { error: null, containers: [], env: process.env }); });

// ✅ NEW: gouvbrain.ejs page route with personas data
app.get(['/gouvbrain', '/gouv-brain'], (_req, res) => {
  noCache(res);
  
  // Default personas matching the frontend
  const DEFAULT_PERSONAS = [
    { id:"pm", name:"Premier Ministre", role:"Chair", ministry:"Primature", focus:"Arbitrage, priorités, exécution", color:"#22c55e", avatarEmoji:"🟢" },
    { id:"fin", name:"Ministre des Finances", role:"SME", ministry:"Finances", focus:"Budget, fiscalité, soutenabilité", color:"#f59e0b", avatarEmoji:"🟠" },
    { id:"plan", name:"Plan & Développement", role:"SME", ministry:"Plan", focus:"ROI, investissements, PPP", color:"#a855f7", avatarEmoji:"🟣" },
    { id:"int", name:"Intérieur", role:"SME", ministry:"Intérieur", focus:"Sécurité intérieure, gouvernance locale", color:"#3b82f6", avatarEmoji:"🔵" },
    { id:"just", name:"Justice", role:"SME", ministry:"Justice", focus:"Conformité, risques juridiques", color:"#ef4444", avatarEmoji:"🔴" },
    { id:"def", name:"Défense", role:"SME", ministry:"Défense", focus:"Souveraineté, risques stratégiques", color:"#64748b", avatarEmoji:"⚫" },
    { id:"health", name:"Santé", role:"SME", ministry:"Santé", focus:"Impact sanitaire, urgence, capacités", color:"#14b8a6", avatarEmoji:"🟦" },
    { id:"edu", name:"Éducation", role:"SME", ministry:"Éducation", focus:"Compétences, formation, inclusion", color:"#06b6d4", avatarEmoji:"🧊" },
    { id:"energy", name:"Hydrocarbures & Énergie", role:"SME", ministry:"Énergie", focus:"Énergie, chaîne de valeur, revenus", color:"#fb7185", avatarEmoji:"🌸" },
    { id:"digital", name:"Économie Numérique", role:"SME", ministry:"Numérique", focus:"Data, IA, cyber, interopérabilité", color:"#10b981", avatarEmoji:"🟩" },
    { id:"env", name:"Environnement", role:"SME", ministry:"Environnement", focus:"ESG, conformité, climat", color:"#84cc16", avatarEmoji:"🟩" },
  ];
  
  res.render('gouvbrain', { 
    error: null, 
    env: process.env,
    user: { name: "Secrétariat Général" },
    cabinetTitle: "GouvBrain — Conseil des Ministres (République du Congo)",
    meetingName: "Session IA • Analyse & Décision",
    personas: DEFAULT_PERSONAS
  });
});

// ── 404 & error handler ───────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.url.startsWith('/api/')) {
    return res.status(404).json({ 
      ok: false, 
      error: `Endpoint not found: ${req.method} ${req.url}`,
      availableEndpoints: [
        '/api/health',
        '/api/ollama/chat',
        '/api/gouvbrain/ingest',
        '/api/ollama/health',
        '/api/aidesk/health',
        '/api/firewall-stats'
      ]
    });
  }
  next();
});
app.use((err, _req, res, _next) => {
  console.error('Unhandled server error:', err.stack || err.message);
  if (!res.headersSent) res.status(500).json({ 
    error: 'Unexpected server error', 
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// ── Boot ──────────────────────────────────────────────────────────────────
(async function startServer() {
  try {
    await loadFirewallConfig();

    const server = app.listen(PORT, () => {
      console.log('\n🚀 Server started');
      console.log(`     Port: ${PORT}`);
      console.log(`     URL:  http://localhost:${PORT}`);
      console.log(`     Graphene PKCS11: ${grapheneInitialized ? 'Initialized' : 'Not initialized'}`);
      console.log(`     OPENSSL_BIN: ${OPENSSL}`);
      console.log(`     OPENSSL_MODULES: ${process.env.OPENSSL_MODULES || getOpenSSLModulesPath()}`);
      console.log(`     PKCS11_SLOT_ID: ${process.env.PKCS11_SLOT_ID}`);
      console.log(`     PKCS11_TOKEN_LABEL: ${process.env.PKCS11_TOKEN_LABEL}`);
      console.log(`     OLLAMA_BASE_URL: ${OLLAMA_BASE_URL}`);
      console.log(`     OLLAMA_MODEL: ${OLLAMA_DEFAULT_MODEL}`);

      console.log('\n🧠 GouvBrain ingest router:');
      console.log(`     POST ${GOUVBRAIN_INGEST_PATH}  -> ${QDRANT_GOUVBRAIN_COLLECTION}`);
      console.log(`     POST ${GOUVGPT_INGEST_PATH}    -> ${QDRANT_GOUVGPT_COLLECTION}`);
      console.log('     POST /api/ingest               -> tag-based routing');
      console.log('     GET  /api/gouvbrain/config     -> config view');
      console.log('     GET  /gouvbrain                -> gouvbrain.ejs');

      console.log('\n📄 GouvBrain endpoints:');
      console.log('     GET  /api/gouvbrain/doc/:docId -> document metadata (stub)');
      console.log('     Response format: { docId, title, pages, summary, keyTopics[] }');

      console.log('\n🦙 Ollama chat proxy:');
      console.log('     POST /api/ollama/chat');
      console.log('     POST /api/ai/ollama/chat (alias)');

      console.log('\n📡 Health & Status endpoints:');
      console.log('     GET  /api/health');
      console.log('     GET  /api/health/detailed');
      console.log('     GET  /api/ollama/health        -> Ollama status');
      console.log('     GET  /api/aidesk/health        -> Real AIDesk status (not Ollama proxy)');
      console.log('     GET  /api/ollama/tags          -> Available models');
      console.log('     GET  /api/firewall-stats       -> Firewall statistics');
      console.log('     GET  /api/firewall-config      -> Firewall configuration');
      
      console.log('\n👥 AIDesk data endpoints:');
      console.log('     GET  /api/aidesk/project');
      console.log('     GET  /api/aidesk/staff');
      console.log('     GET  /api/aidesk/items');
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT} is already in use`);
        console.log('Change GOUVGPT_PORT (or PORT) in .env or free the port.');
        process.exit(1);
      }
      console.error('Listen error:', err);
      process.exit(1);
    });

    const shutdown = () => {
      try { grapheneModule && grapheneModule.finalize(); } catch (_) {}
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

  } catch (err) {
    console.error('💥 Startup failed:', err);
    process.exit(1);
  }
})();