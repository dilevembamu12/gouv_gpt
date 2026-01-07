// public/assets/js/signature.js
// Real signatures & verification for FIntraX using OpenSSL CMS + HSM (pkcs11).
// Tries OpenSSL 3 provider first, then legacy engine as fallback.
// Exports: registerSignatureRoutes(app, deps)

'use strict';

const path   = require('path');
const fs     = require('fs').promises;
const fssync = require('fs');
const crypto = require('crypto');

// ---------- small utils ----------
function genId() { return crypto.randomBytes(12).toString('hex'); }
async function loadJSON(file, fallback) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; } }
async function saveJSON(file, data) { await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8'); }
function isTrue(v) { return v === true || String(v).toLowerCase() === 'true'; }

// Store helpers (file path is injected via deps.SIGS_JSON)
async function getSignStore(SIGS_JSON) { return await loadJSON(SIGS_JSON, { total: 0, items: [] }); }
async function persistSignStore(SIGS_JSON, store) {
  store.total = store.items.length;
  await saveJSON(SIGS_JSON, store);
}

// Build a robust set of PKCS#11 key URIs (id hex bytes, id ASCII, object label). Always include ;pin-value=…
function pkcs11KeyUris(objectId, pin) {
  const idStr = String(objectId || '').trim();
  const pinFrag = pin ? `;pin-value=${encodeURIComponent(String(pin))}` : '';
  const out = new Set();
  if (!idStr) return Array.from(out);

  // hex byte encoding (%01%02...)
  if (/^[0-9a-fA-F]{2,}$/.test(idStr) && idStr.length % 2 === 0) {
    const perc = idStr.replace(/(..)/g, '%$1').toUpperCase();
    out.add(`pkcs11:id=${perc};type=private${pinFrag}`);
  }

  // ASCII encoding of raw string as bytes (%30%31 for "01")
  const asciiPerc = Array.from(idStr).map(c => '%' + c.charCodeAt(0).toString(16).padStart(2,'0')).join('').toUpperCase();
  if (asciiPerc) out.add(`pkcs11:id=${asciiPerc};type=private${pinFrag}`);

  // object label fallback
  out.add(`pkcs11:slot-id=0;object=${encodeURIComponent(idStr)};type=private${pinFrag}`);

  return Array.from(out);
}

async function ensurePkcs11Provider(execFileAsync, openssl, providerPath) {
  const args = [
    'list', '-providers',
    '-provider-path', providerPath,
    '--provider', 'pkcs11',
    '--provider', 'default'
  ];
  const out = await execFileAsync(openssl, args, { env: { OPENSSL_MODULES: providerPath } });
  if (!out.ok) return { ok:false, error: out.stderr || 'openssl list -providers failed' };
  const s = (out.stdout || '') + (out.stderr || '');
  const hasPkcs11 = /Provider:\s*pkcs11/i.test(s);
  const hasDefault = /Provider:\s*default/i.test(s);
  return { ok: hasPkcs11 && hasDefault, error: hasPkcs11 ? (hasDefault ? '' : 'default provider missing') : 'pkcs11 provider missing' };
}

async function ensurePkcs11Engine(execFileAsync, openssl) {
  const attempts = [
    ['engine', '-t', 'pkcs11'],
  ];
  if (process.env.OPENSSL_ENGINE_SO) {
    attempts.push([
      'engine', '-t', 'dynamic',
      '-pre', `SO_PATH:${process.env.OPENSSL_ENGINE_SO}`,
      '-pre', 'ID:pkcs11',
      '-pre', 'LIST_ADD:1',
      '-pre', 'LOAD'
    ]);
  }
  for (const args of attempts) {
    const out = await execFileAsync(openssl, args);
    if (out.ok && /pkcs11/i.test((out.stdout || '') + (out.stderr || ''))) return { ok: true };
  }
  return { ok:false, error: 'pkcs11 engine not available (install libengine-pkcs11-openssl or set OPENSSL_ENGINE_SO)' };
}

/**
 * Dump a certificate from the token to a temp PEM file (if `certPem` not provided).
 * Tries both id encodings and object label.
 */
async function ensureSignerCertPem({ execFileAsync, modulePath, uploadsDir, keyId, providedCertPem, PKCS11_TOOL, OPENSSL }) {
  // Provided PEM
  if (providedCertPem && /-----BEGIN CERTIFICATE-----/.test(providedCertPem)) {
    const p = path.join(uploadsDir, `signer-${Date.now()}-${Math.random().toString(36).slice(2)}.pem`);
    await fs.writeFile(p, providedCertPem, 'utf8');
    return { pemPath: p, cleanup: [p] };
  }

  // Try to read cert object by multiple ids/object
  const candidates = [];
  const idStr = String(keyId || '').trim();
  if (!idStr) return { error: 'Missing key id for locating certificate on token', cleanup: [] };

  candidates.push(['--id', idStr]);       // raw id
  candidates.push(['--label', idStr]);    // label as fallback

  const derPath = path.join(uploadsDir, `cert-${Date.now()}-${Math.random().toString(36).slice(2)}.der`);
  const cleanup = [];
  let found = false;

  for (const sel of candidates) {
    const args = ['--module', modulePath, '--read-object', '--type', 'cert', ...sel, '--output-file', derPath];
    const out = await execFileAsync(PKCS11_TOOL, args);
    if (out.ok && fssync.existsSync(derPath) && fssync.statSync(derPath).size > 0) { found = true; break; }
  }

  if (!found) {
    if (fssync.existsSync(derPath)) cleanup.push(derPath);
    return { error: 'Signer certificate not found on token (provide signerCertPem in body)', cleanup };
  }

  const pemPath = path.join(uploadsDir, `cert-${Date.now()}-${Math.random().toString(36).slice(2)}.pem`);
  cleanup.push(derPath, pemPath);
  const conv = await execFileAsync(OPENSSL, ['x509', '-inform', 'DER', '-in', derPath, '-outform', 'PEM', '-out', pemPath]);
  if (!conv.ok) return { error: conv.stderr || 'openssl x509 failed (DER→PEM)', cleanup };

  return { pemPath, cleanup };
}

// Multer fields for verify route (avoid IIFEs / syntax issues)
let verifyUpload = null;
function ensureVerifyUpload(multerInstance) {
  if (verifyUpload) return verifyUpload;
  verifyUpload = multerInstance.fields([
    { name: 'cms', maxCount: 1 },
    { name: 'content', maxCount: 1 },
    { name: 'ca', maxCount: 1 },
    { name: 'signature', maxCount: 1 },
    { name: 'document', maxCount: 1 },
    { name: 'file', maxCount: 1 },
    { name: 'data', maxCount: 1 },
  ]);
  return verifyUpload;
}

/**
 * Register all signature endpoints.
 * deps: { upload, UPLOADS_DIR, SIGS_JSON, execFileAsync, ensureModuleOr500, mapPkcs11Error,
 *         getUserPin, currentModulePath, OPENSSL, addAudit, logPKI, noCache, PKCS11_TOOL }
 */
function registerSignatureRoutes(app, deps) {
  const {
    upload,
    UPLOADS_DIR,
    SIGS_JSON,                    // <— use the store path passed by devops.js
    execFileAsync,
    ensureModuleOr500,
    mapPkcs11Error,
    getUserPin,
    currentModulePath,
    OPENSSL,
    addAudit,
    logPKI,
    noCache,
    PKCS11_TOOL
  } = deps;

  const openssl = OPENSSL || 'openssl';
  const opensslModulesPath = process.env.OPENSSL_MODULES || '/usr/lib/x86_64-linux-gnu/ossl-modules';

  // --- ensure signatures store path exists and is initialized ---
  try {
    const dir = path.dirname(SIGS_JSON);
    if (!fssync.existsSync(dir)) fssync.mkdirSync(dir, { recursive: true });
    if (!fssync.existsSync(SIGS_JSON)) {
      fssync.writeFileSync(SIGS_JSON, JSON.stringify({ total: 0, items: [] }, null, 2), 'utf8');
    }
  } catch (e) {
    // If we cannot ensure the store, log but don't crash; routes will still respond with fallbacks
    console.error('[SIGN] init store failed:', e);
  }

  // List signatures
  app.get('/api/pki/signatures', async (req, res) => {
    noCache(res);
    const store = await getSignStore(SIGS_JSON);
    logPKI(req, 200, `signatures.count=${store.total}`);
    res.json({ ok: true, total: store.total, items: store.items, signatures: store.items });
  });

  // Download signed artefact
  app.get('/downloads/signatures/:id', async (req, res) => {
    try {
      const store = await getSignStore(SIGS_JSON);
      const item = store.items.find(s => s.id === req.params.id);
      if (!item || !item.outputPath) return res.status(404).json({ ok: false, error: 'Signed file not found' });
      if (!fssync.existsSync(item.outputPath)) return res.status(404).json({ ok: false, error: 'File missing on disk' });
      res.download(item.outputPath, item.outputName || path.basename(item.outputPath));
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // REAL CMS/PKCS#7 signer (HSM): provider-first, engine fallback
  app.post('/api/pki/documents/sign', upload.single('document'), async (req, res) => {
    noCache(res);
    const cleanup = [];
    try {
      if (!req.file) { logPKI(req, 400, 'no_file'); return res.status(400).json({ ok: false, error: 'No document uploaded (field name: document)' }); }
      const modulePath = ensureModuleOr500(res); if (!modulePath) return;

      const userPin = getUserPin(req.body?.pin);
      if (!userPin) return res.status(400).json({ ok: false, error: 'USER PIN missing: set USER_PIN in .env or provide pin' });

      const keyId = String(req.body?.certificateId || req.body?.keyId || '').trim();
      if (!keyId) return res.status(400).json({ ok: false, error: 'certificateId (or keyId) required (HSM object id or label)' });

      const detached = req.body?.detached === undefined ? true : isTrue(req.body.detached);
      const suppliedCertPem = req.body?.signerCertPem || null;

      // Ensure we have a signer certificate PEM
      const cert = await ensureSignerCertPem({
        execFileAsync, modulePath, uploadsDir: UPLOADS_DIR, keyId, providedCertPem: suppliedCertPem, PKCS11_TOOL, OPENSSL: openssl
      });
      cleanup.push(...(cert.cleanup || []));
      if (cert.error) { logPKI(req, 400, `signer_cert_missing: ${cert.error}`); return res.status(400).json({ ok: false, error: cert.error }); }

      const id = genId();
      const nowIso = new Date().toISOString();
      const originalName = req.file.originalname || 'document.bin';
      const ext = path.extname(originalName) || '';
      const base = path.basename(originalName, ext);
      const outputName = detached ? `${base}.p7s` : `${base}.p7m`;
      const outputPath = path.join(UPLOADS_DIR, `${id}-${outputName}`);

      // Provider-first attempt (OpenSSL 3)
      const providerWanted = String(process.env.OPENSSL_USE_ENGINE || '0') !== '1';
      let usedMode = null;
      let lastErr = null;

      if (providerWanted) {
        const prov = await ensurePkcs11Provider(execFileAsync, openssl, opensslModulesPath);
        if (prov.ok) {
          const keyUris = pkcs11KeyUris(keyId, userPin);
          let ok = false, last = null;
          for (const uri of keyUris) {
            const args = [
              'cms', '-sign',
              '-provider-path', opensslModulesPath,
              '--provider', 'pkcs11',
              '--provider', 'default',
              '-propquery', 'provider=pkcs11',
              '-inkey', uri,
              '-signer', cert.pemPath,
              '-binary',
              '-in', req.file.path,
              '-out', outputPath,
              '-outform', 'DER'
            ];
            if (detached) args.push('-detached');
            last = await execFileAsync(openssl, args);
            if (last.ok) { ok = true; usedMode = 'provider'; break; }
          }
          if (!ok) lastErr = `OpenSSL cms sign failed (provider): ${(last && (last.stderr || last.stdout)) || 'error'}`;
        } else {
          lastErr = `Provider preflight: ${prov.error} (OPENSSL_MODULES=${opensslModulesPath})`;
        }
      }

      // Engine fallback
      if (!usedMode) {
        const eng = await ensurePkcs11Engine(execFileAsync, openssl);
        if (!eng.ok) throw new Error(`OpenSSL pkcs11 engine not available. ${eng.error}`);
        const keyUris = pkcs11KeyUris(keyId, userPin);
        let ok = false, last = null;
        for (const uri of keyUris) {
          const args = [
            'cms', '-sign',
            '-engine', 'pkcs11',
            '-keyform', 'engine',
            '-inkey', uri,
            '-signer', cert.pemPath,
            '-binary',
            '-in', req.file.path,
            '-out', outputPath,
            '-outform', 'DER'
          ];
          if (detached) args.push('-detached');
          last = await execFileAsync(openssl, args);
          if (last.ok) { ok = true; usedMode = 'engine'; break; }
        }
        if (!ok) {
          const msg = last ? (last.stderr || last.stdout || 'OpenSSL cms sign failed') : (lastErr || 'OpenSSL cms sign failed');
          throw new Error(msg);
        }
      }

      // Persist signature record
      const record = {
        id,
        ts: nowIso,
        document: originalName,
        inputSize: req.file.size,
        mimeType: req.file.mimetype || 'application/octet-stream',
        status: 'valid',
        algorithm: 'CMS/PKCS#7',
        certificateId: keyId,
        detached,
        mode: usedMode,
        outputPath,
        outputName,
        downloadUrl: `/downloads/signatures/${id}`
      };

      const sigStore = await getSignStore(SIGS_JSON);
      sigStore.items.unshift(record);
      await persistSignStore(SIGS_JSON, sigStore);

      addAudit({ type: 'signature', action: 'sign', file: originalName, status: 'success', id, detached, mode: usedMode });
      logPKI(req, 200, `documents.sign ok id=${id} file=${originalName} detached=${detached} mode=${usedMode}`);
      res.json({ ok: true, signature: record, downloadUrl: record.downloadUrl, mode: usedMode });
    } catch (e) {
      const msg = String(e && e.message || e || 'sign_failed');
      addAudit({ type: 'signature', action: 'sign', status: 'error', error: msg });
      logPKI(req, 500, `documents.sign error: ${msg}`);
      res.status(500).json({ ok: false, error: msg });
    } finally {
      try { if (req.file?.path) await fs.unlink(req.file.path); } catch {}
      for (const p of cleanup) { try { await fs.unlink(p); } catch {} }
    }
  });

  // Raw HSM sign (diagnostics)
  app.post('/api/pkcs11/sign', async (req, res) => {
    noCache(res);
    const modulePath = ensureModuleOr500(res); if (!modulePath) return;

    const userPin = getUserPin(req.body?.pin);
    if (!userPin) return res.status(400).json({ ok: false, error: 'USER PIN missing: set USER_PIN in .env or provide pin' });

    const id = String(req.body?.id || '01');
    const mech = String(req.body?.mechanism || 'SHA256-RSA-PKCS').toUpperCase();
    const msg = String(req.body?.message || '');
    if (!msg) return res.status(400).json({ ok: false, error: 'message is required' });

    const tmpMsg = path.join(UPLOADS_DIR, `msg-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
    const tmpSig = path.join(UPLOADS_DIR, `sig-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
    try {
      await fs.writeFile(tmpMsg, msg, 'utf8');

      const args = ['--module', modulePath, '--login', '--pin', userPin, '--sign', '--mechanism', mech, '--id', id, '--input-file', tmpMsg, '--output-file', tmpSig];
      const out = await execFileAsync(PKCS11_TOOL, args);
      if (!out.ok) return res.status(500).json({ ok: false, error: mapPkcs11Error(out.stderr) || out.stderr, stdout: out.stdout });

      const sigBuf = await fs.readFile(tmpSig);
      return res.json({ ok: true, signatureHex: sigBuf.toString('hex') });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e.message || e) });
    } finally {
      try { await fs.unlink(tmpMsg); } catch {}
      try { await fs.unlink(tmpSig); } catch {}
    }
  });

  // Verify CMS/PKCS#7
  app.post('/api/pki/documents/verify', ensureVerifyUpload(deps.upload), async (req, res) => {
    noCache(res);
    let cmsPath = null, contentPath = null, caPath = null;
    const tempFiles = [];

    try {
      const ROOT_UPLOADS = UPLOADS_DIR;
      const pickFile = (names) => {
        for (const n of names) if (req.files?.[n]?.[0]) return req.files[n][0].path;
        return null;
      };

      // CMS / signature (p7s/p7m)
      cmsPath = pickFile(['cms', 'signature', 'document', 'file']);
      if (!cmsPath && (req.body?.cmsPem || req.body?.cms)) {
        const val = String(req.body.cmsPem || req.body.cms);
        cmsPath = path.join(ROOT_UPLOADS, `cms-${Date.now()}-${Math.random().toString(36).slice(2)}.pem`);
        tempFiles.push(cmsPath);
        const pem = /-----BEGIN/i.test(val)
          ? val
          : `-----BEGIN CMS-----\n${val.replace(/\s+/g, '')}\n-----END CMS-----\n`;
        await fs.writeFile(cmsPath, pem, 'utf8');
      }
      if (!cmsPath) {
        logPKI(req, 400, 'verify.missing_cms');
        return res.status(400).json({ ok: false, error: 'Missing CMS/PKCS#7. Upload .p7s/.p7m or provide body.cmsPem.' });
      }

      // Detached content (optional)
      contentPath = pickFile(['content', 'data']);
      if (!contentPath && typeof req.body?.contentText === 'string') {
        contentPath = path.join(ROOT_UPLOADS, `content-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
        tempFiles.push(contentPath);
        await fs.writeFile(contentPath, req.body.contentText, 'utf8');
      }

      // Optional CA bundle
      caPath = pickFile(['ca']);
      if (!caPath && req.body?.caPem) {
        caPath = path.join(ROOT_UPLOADS, `ca-${Date.now()}-${Math.random().toString(36).slice(2)}.pem`);
        tempFiles.push(caPath);
        const val = String(req.body.caPem);
        const pem = /-----BEGIN/i.test(val)
          ? val
          : `-----BEGIN CERTIFICATE-----\n${val.replace(/\s+/g, '')}\n-----END CERTIFICATE-----\n`;
        await fs.writeFile(caPath, pem, 'utf8');
      }

      // Try PEM then DER
      const verifyArgs = ['cms', '-verify', '-in', cmsPath];
      if (contentPath) verifyArgs.push('-content', contentPath);
      if (caPath) verifyArgs.push('-CAfile', caPath); else verifyArgs.push('-no_verify');
      verifyArgs.push('-out', '/dev/null');

      let verify = await execFileAsync(openssl, verifyArgs);
      let verified = verify.ok;
      let verifyStderr = verify.stderr || '';

      if (!verified) {
        const verifyArgsDer = ['cms', '-verify', '-inform', 'DER', '-in', cmsPath];
        if (contentPath) verifyArgsDer.push('-content', contentPath);
        if (caPath) verifyArgsDer.push('-CAfile', caPath); else verifyArgsDer.push('-no_verify');
        verifyArgsDer.push('-out', '/dev/null');
        const verifyDer = await execFileAsync(openssl, verifyArgsDer);
        verified = verifyDer.ok;
        verifyStderr = verifyDer.stderr || verifyStderr;
      }

      if (!verified) {
        const reason = /S\/MIME|CMS|no content-type|asn1|invalid format/i.test(verifyStderr)
          ? 'Provided file is not a CMS/PKCS#7 signature (.p7s/.p7m).'
          : (verifyStderr || 'Verification failed');
        addAudit({ type: 'cms', action: 'verify', status: 'fail', reason });
        logPKI(req, 400, `cms.verify fail: ${reason}`);
        return res.status(400).json({ ok: false, verified: false, error: reason, stderr: verifyStderr });
      }

      // best-effort signer info
      let signerInfo = '';
      try {
        const printed = await execFileAsync(openssl, ['cms', '-cmsout', '-print', '-in', cmsPath]);
        signerInfo = (printed.stdout || '').slice(0, 4000);
      } catch {}

      addAudit({ type: 'cms', action: 'verify', status: 'success' });
      logPKI(req, 200, 'cms.verify success');
      return res.status(200).json({ ok: true, verified: true, signerInfo });
    } catch (e) {
      addAudit({ type: 'cms', action: 'verify', status: 'error', error: String(e) });
      logPKI(req, 500, `cms.verify.error ${String(e)}`);
      return res.status(500).json({ ok: false, error: String(e.message || e) });
    } finally {
      for (const p of tempFiles) { try { await fs.unlink(p); } catch {} }
    }
  });
}

module.exports = { registerSignatureRoutes };
