// public/assets/js/certificates.js  (SERVER-SIDE MODULE)
// Real certificate issuance using HSM private key (no mocks).
// Provider-first (OpenSSL 3 pkcs11 provider); engine fallback only if OPENSSL_USE_ENGINE=1.
// FIXED: RFC7512-compliant ENGINE usage (no pin-value in URI), pass PIN via -passin,
//        and probe both URI forms (with and without leading "pkcs11:") to avoid double-prefix.
//        Also prefer id=%XX over object=XX for SmartCard-HSM.

'use strict';

const path   = require('path');
const fs     = require('fs').promises;
const fssync = require('fs');
const crypto = require('crypto');

const OPENSSL_BIN = 'openssl';

// ---------- utils ----------
function genId()     { return crypto.randomBytes(12).toString('hex'); }
function genSerial() { return crypto.randomBytes(8).toString('hex').toUpperCase(); }

async function loadJSON(file, fallback) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; } }
async function saveJSON(file, data)     { await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8'); }

async function getCertStore(file) { return await loadJSON(file, { total: 0, certificates: [] }); }
async function persistCertStore(file, store) { store.total = store.certificates.length; await saveJSON(file, store); }

function buildDNFromSubject(subject){
  const s = subject || {};
  const dn = [
    s.CN && `/CN=${String(s.CN).replace(/\//g,'\\/')}`,
    s.O  && `/O=${String(s.O).replace(/\//g,'\\/')}`,
    s.OU && `/OU=${String(s.OU).replace(/\//g,'\\/')}`,
    s.C  && `/C=${String(s.C).replace(/\//g,'\\/')}`,
    s.L  && `/L=${String(s.L).replace(/\//g,'\\/')}`,
    s.email && `/emailAddress=${String(s.email).replace(/\//g,'\\/')}`
  ].filter(Boolean).join('');
  return dn || '/CN=Unknown';
}

/** Safe UI-friendly subject summary (no template literal nesting). */
function formatSubjectSummary(subject){
  const s = subject || {};
  const parts = [];
  parts.push(`CN=${s.CN || 'Unknown'}`);
  if (s.O) parts.push(`O=${s.O}`);
  if (s.OU) parts.push(`OU=${s.OU}`);
  if (s.C) parts.push(`C=${s.C}`);
  if (s.L) parts.push(`L=${s.L}`);
  if (s.email) parts.push(`emailAddress=${s.email}`);
  return parts.join(', ');
}

function encodeAsciiPercent(str){
  return Array.from(String(str || ''))
    .map(c => '%' + c.charCodeAt(0).toString(16).padStart(2,'0'))
    .join('').toUpperCase();
}
function encodeHexPercentIfValid(str){
  const s = String(str || '').trim();
  if (/^[0-9a-fA-F]{2,}$/.test(s) && s.length % 2 === 0) return s.replace(/(..)/g, '%$1').toUpperCase();
  return null;
}

/** Normalize SAN list a bit to reduce OpenSSL picky failures. */
function normalizeSanList(san) {
  const raw = String(san || '').trim();
  if (!raw) return '';
  return raw
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)
    .map(x => {
      const m = x.match(/^([a-zA-Z]+)\s*:\s*(.+)$/);
      if (!m) return x;
      const type = m[1].toUpperCase();
      const val  = m[2].trim();
      if (type === 'DNS') return `DNS:${val}`;
      if (type === 'IP')  return `IP:${val}`;
      if (type === 'EMAIL' || type === 'MAIL') return `email:${val}`;
      return `${m[1]}:${val}`;
    })
    .join(',');
}

/** Read REAL metadata from PEM. */
async function readCertMeta(execFileAsync, openssl, pemPath, envObj) {
  const out = await execFileAsync(
    openssl,
    ['x509','-in', pemPath, '-noout','-serial','-startdate','-enddate','-subject','-issuer'],
    envObj ? { env: envObj } : undefined
  );

  if (!out.ok) {
    throw new Error(`openssl x509 meta failed: ${(out.stderr || out.stdout || '').trim()}`);
  }

  const txt = ((out.stdout || '') + '\n' + (out.stderr || '')).trim();

  const serialRaw = (txt.match(/serial=([0-9A-F:]+)/i)?.[1] || '').trim();
  const serial = serialRaw.replace(/:/g, '').toUpperCase();

  const nb = (txt.match(/notBefore=(.+)/i)?.[1] || '').trim();
  const na = (txt.match(/notAfter=(.+)/i)?.[1] || '').trim();

  const subjectLine = (txt.match(/^subject\s*=\s*(.+)$/im)?.[1] || '').trim();
  const issuerLine  = (txt.match(/^issuer\s*=\s*(.+)$/im)?.[1] || '').trim();

  const issuedISO  = nb ? (isNaN(Date.parse(nb)) ? new Date().toISOString() : new Date(nb).toISOString()) : new Date().toISOString();
  const expiresISO = na ? (isNaN(Date.parse(na)) ? new Date(Date.now()+86400000).toISOString() : new Date(na).toISOString()) : new Date(Date.now()+86400000).toISOString();

  return {
    serial: serial || null,
    issuedISO,
    expiresISO,
    subjectLine: subjectLine || null,
    issuerLine: issuerLine || null
  };
}

// ---------- provider/engine preflights ----------
async function ensurePkcs11Provider(execFileAsync, openssl, providerPath) {
  const args = [
    'list','-providers',
    '-provider-path', providerPath,
    '--provider','pkcs11',
    '--provider','default'
  ];
  const out = await execFileAsync(openssl, args, {
    env: {
      OPENSSL_MODULES: providerPath,
      OPENSSL_CONF: process.env.OPENSSL_CONF || '/dev/null'
    }
  });
  if (!out.ok) return { ok:false, error: out.stderr || 'openssl list -providers failed' };
  const s = (out.stdout || '') + (out.stderr || '');
  const hasPkcs11  = /Provider:\s*pkcs11/i.test(s);
  const hasDefault = /Provider:\s*default/i.test(s);
  return { ok: hasPkcs11 && hasDefault, error: hasPkcs11 ? (hasDefault ? '' : 'default provider missing') : 'pkcs11 provider missing' };
}

async function ensurePkcs11Engine(execFileAsync, openssl) {
  const tryList = [['engine','-t','pkcs11']];
  if (process.env.OPENSSL_ENGINE_SO) {
    tryList.push(['engine','-t','dynamic',
      '-pre', `SO_PATH:${process.env.OPENSSL_ENGINE_SO}`,
      '-pre', 'ID:pkcs11',
      '-pre', 'LIST_ADD:1',
      '-pre', 'LOAD'
    ]);
  }
  for (const args of tryList) {
    const out = await execFileAsync(openssl, args);
    if (out.ok && /pkcs11/i.test((out.stdout || '') + (out.stderr || ''))) return { ok:true };
  }
  return { ok:false, error: 'pkcs11 engine not available (install libengine-pkcs11-openssl or provide OPENSSL_ENGINE_SO)' };
}

/**
 * ✅ Critical: slot-id disambiguation (your fix.sh detected 0)
 */
function getSlotId() {
  const raw = process.env.PKCS11_SLOT_ID;
  if (raw === undefined || raw === null || raw === '') return '0';
  const n = String(raw).trim();
  return /^[0-9]+$/.test(n) ? n : '0';
}

/**
 * ✅ ENGINE-mode URI candidates
 * - RFC7512 strict: DO NOT embed pin-value in URI for OpenSSL engine (it rejects it)
 * - We generate both variants:
 *    A) "pkcs11:slot-id=...;id=%01;type=private"   (some engines expect this)
 *    B) "slot-id=...;id=%01;type=private"         (some engines ADD "pkcs11:" internally; avoids "pkcs11:pkcs11:...")
 */
function engineKeyUris(objectId, tokenLabel) {
  const idStr = String(objectId || '').trim();
  const slotId = getSlotId();
  const out = [];
  if (!idStr) return out;

  const hexPerc   = encodeHexPercentIfValid(idStr);  // "01" => "%01"
  const asciiPerc = encodeAsciiPercent(idStr);

  // IMPORTANT: tokenLabel must be RFC7512-safe; encodeURIComponent is fine here.
  const tokFrag = tokenLabel ? `token=${encodeURIComponent(tokenLabel)};` : '';
  const slotFrag = `slot-id=${encodeURIComponent(slotId)};`;

  // Build attribute strings WITHOUT the leading "pkcs11:" first
  const attr = [];

  // --- best-first: slot-id + id=%XX (CKA_ID bytes) ---
  if (hexPerc) {
    attr.push(`${slotFrag}id=${hexPerc};type=private`);
    if (tokenLabel) attr.push(`${slotFrag}${tokFrag}id=${hexPerc};type=private`);
    if (tokenLabel) attr.push(`${tokFrag}id=${hexPerc};type=private`);
  }

  // --- ascii id fallback ---
  attr.push(`${slotFrag}id=${asciiPerc};type=private`);
  if (tokenLabel) attr.push(`${slotFrag}${tokFrag}id=${asciiPerc};type=private`);

  // --- label/object fallback (least reliable) ---
  attr.push(`${slotFrag}object=${encodeURIComponent(idStr)};type=private`);
  if (tokenLabel) attr.push(`${slotFrag}${tokFrag}object=${encodeURIComponent(idStr)};type=private`);

  // Expand to both forms: with and without pkcs11: prefix
  for (const a of attr) {
    out.push(`pkcs11:${a}`);
    out.push(a); // for engines that auto-prefix (prevents pkcs11:pkcs11:...)
  }

  // De-dup preserve order
  return Array.from(new Set(out));
}

// ---------- shared download helper ----------
async function _sendCertDownload(req, res, getCertStoreFn, CERTS_JSON, logPKI) {
  const { id } = req.params;
  const store = await getCertStoreFn(CERTS_JSON);
  const cert  = store.certificates.find(c => c.id === id);
  if (!cert || !cert.pemPath || !fssync.existsSync(cert.pemPath)) {
    logPKI(req, 404, 'certificate.not_found');
    return res.status(404).json({ ok:false, error:'Certificate not found' });
  }
  res.setHeader('Content-Disposition', `attachment; filename="certificate-${cert.serial || 'unknown'}.pem"`);
  logPKI(req, 200, 'certificate.download');
  res.type('application/x-pem-file').send(await fs.readFile(cert.pemPath, 'utf8'));
}

// ---------- SAN extfile ----------
async function writeExtFileIfNeeded(tmpDir, san, isCA) {
  const trimmed = normalizeSanList(san);
  const lines = [];

  lines.push('basicConstraints=' + (isCA ? 'critical,CA:TRUE' : 'CA:FALSE'));
  lines.push('keyUsage=' + (isCA ? 'critical,keyCertSign,cRLSign' : 'digitalSignature,keyEncipherment'));
  lines.push('extendedKeyUsage=' + (isCA ? 'serverAuth,clientAuth' : 'serverAuth,clientAuth'));

  if (trimmed) lines.push('subjectAltName=' + trimmed);

  const extPath = path.join(tmpDir, `ext-${Date.now()}-${Math.random().toString(36).slice(2)}.cnf`);
  await fs.writeFile(extPath, lines.join('\n') + '\n', 'utf8');
  return extPath;
}

/**
 * @param {import('express').Express} app
 * @param {Object} deps
 */
function registerCertificateRoutes(app, deps) {
  const {
    UPLOADS_DIR,
    CERTS_JSON,
    execFileAsync,
    ensureModuleOr500,
    getUserPin,
    currentModulePath,
    OPENSSL,
    addAudit,
    logPKI,
    noCache,
    PKCS11_TOOL
  } = deps;

  const CERTS_DIR   = path.join(UPLOADS_DIR, 'certs');
  const SIGNER_DIR  = path.join(CERTS_DIR, 'signer');
  if (!fssync.existsSync(CERTS_DIR))  fssync.mkdirSync(CERTS_DIR,  { recursive: true });
  if (!fssync.existsSync(SIGNER_DIR)) fssync.mkdirSync(SIGNER_DIR, { recursive: true });

  // List
  app.get('/api/pki/certificates', async (req, res) => {
    noCache(res);
    const store = await getCertStore(CERTS_JSON);
    const { status, type, search } = req.query || {};
    let list = store.certificates.slice();
    if (status && status !== 'all') list = list.filter(c => c.status === status);
    if (type && type !== 'all')     list = list.filter(c => c.type === type);
    if (search) {
      const term = String(search).toLowerCase();
      list = list.filter(c =>
        (c.subject || '').toLowerCase().includes(term) ||
        (c.issuer  || '').toLowerCase().includes(term) ||
        (c.serial  || '').toLowerCase().includes(term) ||
        (c.email   || '').toLowerCase().includes(term) ||
        (c.keyId   || '').toLowerCase().includes(term)
      );
    }
    logPKI(req, 200, `certificates.total=${list.length}`);
    res.json({ ok: true, total: list.length, certificates: list });
  });

  async function findLatestByKeyId(store, keyId) {
    const cand = (store.certificates || []).filter(c => String(c.keyId || '') === String(keyId));
    if (!cand.length) return null;
    cand.sort((a,b) => new Date(b.issued).getTime() - new Date(a.issued).getTime());
    return cand[0];
  }

  app.get('/api/pki/certificates/by-key/:keyId', async (req, res) => {
    noCache(res);
    const { keyId } = req.params || {};
    const store = await getCertStore(CERTS_JSON);
    const cert = await findLatestByKeyId(store, keyId);
    if (!cert) return res.status(404).json({ ok:false, error: 'No certificate found for keyId' });
    res.json({ ok:true, certificate: cert });
  });

  app.get('/api/pki/certificates/by-key/:keyId/pem', async (req, res) => {
    noCache(res);
    const { keyId } = req.params || {};
    const pemPath = path.join(SIGNER_DIR, `${keyId}.pem`);
    if (!fssync.existsSync(pemPath)) return res.status(404).json({ ok:false, error:'Signer PEM not found' });
    res.setHeader('Content-Disposition', `attachment; filename="signer-${keyId}.pem"`);
    res.type('application/x-pem-file').send(await fs.readFile(pemPath, 'utf8'));
  });

  app.get('/downloads/signer/:keyId.pem', async (req, res) => {
    noCache(res);
    const { keyId } = req.params || {};
    const pemPath = path.join(SIGNER_DIR, `${keyId}.pem`);
    if (!fssync.existsSync(pemPath)) return res.status(404).send('Not found');
    res.type('application/x-pem-file').send(await fs.readFile(pemPath, 'utf8'));
  });

  // -------------------------
  // CERT GENERATION HANDLER
  // -------------------------
  const generateHandler = async (req, res) => {
    noCache(res);
    const cleanup = [];
    try {
      const modulePath = ensureModuleOr500(res); if (!modulePath) return;

      const body = req.body || {};
      const validityDays = Number(body.validityDays || 365);

      const keyId = String(body?.key?.id || body?.keyId || body?.id || '').trim();
      if (!keyId) return res.status(400).json({ ok:false, error:'key.id (HSM object id or label) is required' });

      const userPin = getUserPin(body.pin);
      if (!userPin) return res.status(400).json({ ok:false, error:'USER PIN missing: set USER_PIN in .env or provide pin' });

      const subject = body.subject || {};
      const subjectDN = buildDNFromSubject(subject);
      const san = (body.san && String(body.san).trim()) || '';

      const certId    = genId();
      const tmpCsr    = path.join(CERTS_DIR, `csr-${certId}.pem`);
      const pemPath   = path.join(CERTS_DIR, `cert-${certId}.pem`);
      const derPath   = path.join(CERTS_DIR, `cert-${certId}.der`);
      const signerPem = path.join(SIGNER_DIR, `${keyId}.pem`);
      cleanup.push(tmpCsr, pemPath, derPath);

      const extFile = await writeExtFileIfNeeded(CERTS_DIR, san, !!body.isCA);
      cleanup.push(extFile);

      const openssl = OPENSSL || process.env.OPENSSL_BIN || OPENSSL_BIN;
      const opensslModulesPath =
        process.env.OPENSSL_MODULES ||
        '/usr/lib/x86_64-linux-gnu/ossl-modules';

      // Provider-first unless explicitly engine
      const forceEngine = String(process.env.OPENSSL_USE_ENGINE || '0') === '1';
      let usedMode = null;
      let lastErr = null;

      let providerEnvUsed = null;

      // token label probes (your UI shows SmartCard-HSM; env shows SC-HSM)
      const tokenLabelCandidates = Array.from(new Set([
        process.env.PKCS11_TOKEN_LABEL,
        process.env.PKCS11_TOKEN,
        'SmartCard-HSM',
        'SC-HSM'
      ].filter(Boolean)));

      const slotId = getSlotId();

      // -------- Provider mode --------
      if (!forceEngine) {
        const prov = await ensurePkcs11Provider(execFileAsync, openssl, opensslModulesPath);
        if (!prov.ok) {
          lastErr = `Provider preflight failed: ${prov.error}`;
        } else {
          usedMode = 'provider';

          const mod  = encodeURIComponent(currentModulePath());
          const pinv = encodeURIComponent(userPin);

          const encHex   = encodeHexPercentIfValid(keyId);   // "01" -> "%01"
          const encAscii = encodeAsciiPercent(keyId);

          const pkcs11Env = {
            OPENSSL_MODULES: opensslModulesPath,
            OSSL_PROVIDER_PKCS11_MODULE: currentModulePath(),
            OPENSSL_CONF: '/dev/null'
          };
          providerEnvUsed = pkcs11Env;

          let ok = false;
          let workingUri = null;
          let csrOut = null;

          // Try each token label candidate; and slot-first URIs
          for (const tokenLabel of tokenLabelCandidates) {
            const provUris = [
              // slot-id + id (best)
              encHex   && `pkcs11:slot-id=${slotId};id=${encHex};type=private;pin-value=${pinv}`,
              encHex   && `pkcs11:slot-id=${slotId};id=${encHex};type=private`,
              // token + id
              encHex   && `pkcs11:token=${encodeURIComponent(tokenLabel)};id=${encHex};type=private;pin-value=${pinv}`,
              encHex   && `pkcs11:token=${encodeURIComponent(tokenLabel)};id=${encHex};type=private`,
              // module-path + id
              encHex   && `pkcs11:module-path=${mod};id=${encHex};type=private;pin-value=${pinv}`,
              encHex   && `pkcs11:module-path=${mod};id=${encHex};type=private`,

              // ascii id fallback
              `pkcs11:slot-id=${slotId};id=${encAscii};type=private;pin-value=${pinv}`,
              `pkcs11:token=${encodeURIComponent(tokenLabel)};id=${encAscii};type=private;pin-value=${pinv}`,
              `pkcs11:module-path=${mod};id=${encAscii};type=private;pin-value=${pinv}`,

              // object/label fallback
              `pkcs11:slot-id=${slotId};object=${encodeURIComponent(keyId)};type=private;pin-value=${pinv}`,
              `pkcs11:token=${encodeURIComponent(tokenLabel)};object=${encodeURIComponent(keyId)};type=private;pin-value=${pinv}`,
              `pkcs11:module-path=${mod};object=${encodeURIComponent(keyId)};type=private;pin-value=${pinv}`,
            ].filter(Boolean);

            for (const tryUri of provUris) {
              const csrArgs = [
                'req','-new','-utf8',
                '-provider-path', opensslModulesPath,
                '--provider','pkcs11','--provider','default',
                '-sha256',
                '-key', tryUri,
                '-subj', subjectDN,
                '-out', tmpCsr
              ];
              csrOut = await execFileAsync(openssl, csrArgs, { env: pkcs11Env });
              if (csrOut.ok && fssync.existsSync(tmpCsr)) { ok = true; workingUri = tryUri; break; }
            }
            if (ok) break;
          }

          if (!ok) {
            usedMode = null;
            lastErr = `Provider CSR failed. ${((csrOut && (csrOut.stderr || csrOut.stdout)) || '').trim()}`;
          } else {
            const x509Args = [
              'x509','-req',
              '-provider-path', opensslModulesPath,
              '--provider','pkcs11','--provider','default',
              '-sha256',
              '-in', tmpCsr,
              '-signkey', workingUri,
              '-days', String(validityDays),
              '-out', pemPath,
              '-extfile', extFile
            ];

            const x509 = await execFileAsync(openssl, x509Args, { env: pkcs11Env });
            if (!x509.ok || !fssync.existsSync(pemPath)) {
              throw new Error(`Provider x509 self-sign failed: ${(x509.stderr || x509.stdout || 'error').trim()}`);
            }

            const conv = await execFileAsync(
              openssl,
              ['x509','-in', pemPath, '-out', derPath, '-outform', 'DER'],
              { env: pkcs11Env }
            );
            if (!conv.ok || !fssync.existsSync(derPath)) {
              throw new Error(`openssl x509 DER failed: ${(conv.stderr || conv.stdout || 'error').trim()}`);
            }
          }
        }
      }

      // -------- Engine fallback --------
      if (!usedMode) {
        const eng = await ensurePkcs11Engine(execFileAsync, openssl);
        if (!eng.ok) {
          throw new Error(`OpenSSL engine mode failed. ${eng.error}. Provider error: ${lastErr || 'n/a'}`);
        }
        usedMode = 'engine';

        let engineOk = false;
        let engineKeyUri = null;
        let csrOut = null;

        // Try token labels + both URI prefix variants
        for (const tokenLabel of tokenLabelCandidates) {
          const keyUris = engineKeyUris(keyId, tokenLabel);

          for (const tryUri of keyUris) {
            const csrArgs = [
              'req','-new','-utf8',
              '-engine','pkcs11','-keyform','engine',
              // ✅ PIN passed via -passin (RFC7512 strict, avoids pin-value)
              '-passin', `pass:${userPin}`,
              '-key', tryUri,
              '-subj', subjectDN,
              '-out', tmpCsr
            ];
            csrOut = await execFileAsync(openssl, csrArgs);
            if (csrOut.ok && fssync.existsSync(tmpCsr)) { engineOk = true; engineKeyUri = tryUri; break; }
          }
          if (engineOk) break;
        }

        if (!engineOk) throw new Error(`Engine CSR failed: ${((csrOut && (csrOut.stderr || csrOut.stdout)) || '').trim()}`);

        const x509Args = [
          'x509','-req',
          '-engine','pkcs11','-keyform','engine',
          '-passin', `pass:${userPin}`,
          '-in', tmpCsr,
          '-signkey', engineKeyUri,
          '-days', String(validityDays),
          '-out', pemPath,
          '-extfile', extFile
        ];
        const x509 = await execFileAsync(openssl, x509Args);
        if (!x509.ok || !fssync.existsSync(pemPath)) throw new Error(`Engine x509 self-sign failed: ${(x509.stderr || x509.stdout || 'error').trim()}`);

        const conv = await execFileAsync(openssl, ['x509','-in', pemPath, '-out', derPath, '-outform', 'DER']);
        if (!conv.ok || !fssync.existsSync(derPath)) throw new Error(`openssl x509 DER failed: ${(conv.stderr || conv.stdout || 'error').trim()}`);
      }

      // Persist stable signer PEM
      try {
        const pemData = await fs.readFile(pemPath, 'utf8');
        await fs.writeFile(signerPem, pemData, 'utf8');
      } catch (e) {
        console.warn('[CERT] Failed to persist signer PEM:', e.message || e);
      }

      // Optional: import cert to token (label/id)
      if (body.importToToken !== false) {
        const label = String(body.label || `Cert-${keyId}`);
        const pkcs11ToolBin = PKCS11_TOOL || 'pkcs11-tool';
        const args = [
          '--module', currentModulePath(),
          '--login', '--pin', userPin,
          '--write-object', derPath,
          '--type', 'cert',
          '--label', label
        ];
        if (/^[0-9a-fA-F]{2,}$/.test(keyId) && keyId.length % 2 === 0) args.push('--id', keyId);
        const wr = await execFileAsync(pkcs11ToolBin, args);
        if (!wr.ok) console.warn('[CERT] Import to token failed:', (wr.stderr || wr.stdout || 'error').trim());
      }

      // Record REAL certificate metadata
      const meta = await readCertMeta(execFileAsync, openssl, pemPath, usedMode === 'provider' ? providerEnvUsed : null);

      const apiDownloadUrl = `/api/pki/certificates/${certId}/download`;
      const fsDownloadUrl  = `/downloads/certificates/${certId}`;
      const signerPemUrl   = `/downloads/signer/${encodeURIComponent(keyId)}.pem`;

      const certRecord = {
        id: certId,
        keyId,
        subject: formatSubjectSummary(subject),
        issuer: meta.issuerLine || 'SELF',
        serial: meta.serial || genSerial(),
        issued: meta.issuedISO,
        expires: meta.expiresISO,
        status: 'valid',
        type: body.type || 'server',
        keyType: (body.key && (body.key.algorithm || body.key.type || 'RSA')) || 'RSA',
        keySize: (body.key && (body.key.param || '2048')) || '2048',
        algorithm: `${(body.key && (body.key.algorithm || body.key.type || 'RSA')) || 'RSA'}-${(body.key && (body.key.param || '2048')) || '2048'}`,
        email: subject.email || null,
        pemPath,
        derPath,
        signerPemPath: signerPem,
        signerPemUrl,
        downloadUrl: fsDownloadUrl,
        apiDownloadUrl,
        metaSubject: meta.subjectLine || null,
        mode: usedMode,
        pkcs11SlotId: getSlotId(),
        pkcs11Token: tokenLabelCandidates[0] || null
      };

      const store = await getCertStore(CERTS_JSON);
      store.certificates.unshift(certRecord);
      await persistCertStore(CERTS_JSON, store);

      await addAudit({ type:'certificate', action:'generate', subject: certRecord.subject, status:'success', mode: usedMode, keyId });
      logPKI(req, 200, `certificate.generate id=${certId} keyId=${keyId} mode=${usedMode}`);
      res.json({ ok:true, certificate: certRecord, mode: usedMode });

    } catch (e) {
      for (const p of cleanup) { try { await fs.unlink(p); } catch {} }
      const errMsg = String(e.message || e);
      await addAudit({ type:'certificate', action:'generate', status:'error', error: errMsg });
      logPKI(req, 500, errMsg);
      res.status(500).json({ ok:false, error: errMsg });
    }
  };

  // Compatibility
  app.post('/api/pki/certificates', generateHandler);
  app.post('/api/pki/certificates/generate', generateHandler);

  // Logical revoke
  app.post('/api/pki/certificates/:id/revoke', async (req, res) => {
    noCache(res);
    try {
      const { id } = req.params;
      const reason = (req.body && req.body.reason) || 'unspecified';
      const store = await getCertStore(CERTS_JSON);
      const idx = store.certificates.findIndex(c => c.id === id);
      if (idx === -1) { logPKI(req, 404, 'certificate.not_found'); return res.status(404).json({ ok:false, error:'Certificate not found' }); }
      const cert = store.certificates[idx];
      cert.status = 'revoked';
      cert.revocationDate = new Date().toISOString();
      cert.revocationReason = reason;
      await persistCertStore(CERTS_JSON, store);
      await addAudit({ type:'certificate', action:'revoke', serial: cert.serial, reason, status:'success' });
      logPKI(req, 200, 'certificate.revoke');
      res.json({ ok:true, certificate: cert });
    } catch (e) {
      await addAudit({ type:'certificate', action:'revoke', status:'error', error:String(e) });
      logPKI(req, 500, String(e));
      res.status(500).json({ ok:false, error:String(e) });
    }
  });

  // Downloads
  app.get('/downloads/certificates/:id', async (req, res) => {
    noCache(res);
    await _sendCertDownload(req, res, getCertStore, CERTS_JSON, logPKI);
  });
  app.get('/api/pki/certificates/:id/download', async (req, res) => {
    noCache(res);
    await _sendCertDownload(req, res, getCertStore, CERTS_JSON, logPKI);
  });
}

module.exports = { registerCertificateRoutes };
