/**
 * gouvgpt.js — Orchestrateur Backend FinTraX
 * Mode: Stockage MinIO & Délégation n8n (Pure Ingestion)
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const fs = require('fs').promises;
const fssync = require('fs');
const multer = require('multer');
const cors = require('cors');
const Minio = require('minio');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 4321);

// --- CONFIGURATION WEBHOOKS ---
const N8N_QDRANT_WEBHOOK = process.env.N8N_QDRANT_WEBHOOK || "http://192.168.12.75:5678/webhook-test/qdrant-ops";
const N8N_CHAT_WEBHOOK = process.env.N8N_CHAT_WEBHOOK_URL; 
const QDRANT_COLLECTION = "gouvbrain_knowledge";

// --- Configuration Gemini ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${GEMINI_API_KEY}`;

// --- Initialisation MinIO ---
const minioClient = new Minio.Client({
    endPoint: process.env.MINIO_ENDPOINT || 'localhost',
    port: Number(process.env.MINIO_PORT || 9000),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin'
});
const MINIO_BUCKET = process.env.MINIO_BUCKET || 'gouvbrain-knowledge';

(async () => {
    try {
        const exists = await minioClient.bucketExists(MINIO_BUCKET);
        if (!exists) {
            await minioClient.makeBucket(MINIO_BUCKET, 'us-east-1');
            console.log(`[MinIO] Bucket '${MINIO_BUCKET}' créé.`);
        }
    } catch (err) { console.warn("[MinIO] Warning:", err.message); }
})();

// --- Helpers ---
async function readJson(file, defaultVal) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return defaultVal; }
}
async function writeJson(file, data) {
    await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// --- Middleware ---
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ dest: path.join(__dirname, 'uploads') });
const PERSONAS_CONFIG_PATH = path.join(__dirname, 'public/data/personas.config.json');
const DEFAULT_PERSONAS = [{ id: "pm", name: "Premier Ministre", role: "Chair", ministry: "Primature", color: "#22c55e", avatarEmoji: "🟢", systemPrompt: "Tu es le PM.", knowledge: [] }];

// ==========================================
// ROUTES INGESTION (Node -> MinIO -> n8n)
// ==========================================

// 1. Ingestion de FICHIER (PDF/TXT/DOCX...)
app.post('/api/admin/personas/:personaId/knowledge/file', upload.single('file'), async (req, res) => {
    try {
        const { personaId } = req.params;
        const file = req.file;
        if (!file) throw new Error("Fichier manquant");

        console.log(`[Ingest] Upload MinIO: ${file.originalname} pour ${personaId}`);

        // A. Sauvegarde MinIO
        const objectName = `${personaId}/${Date.now()}_${file.originalname}`;
        const fileStream = fssync.createReadStream(file.path);
        
        // On upload le fichier brut
        await minioClient.putObject(MINIO_BUCKET, objectName, fileStream, file.size, {
            'Content-Type': file.mimetype
        });
        
        // B. Génération d'un lien temporaire pour n8n (Valide 24h)
        const presignedUrl = await minioClient.presignedGetObject(MINIO_BUCKET, objectName, 24 * 60 * 60);

        // C. Envoi de l'URL au Webhook n8n
        // n8n se chargera de télécharger, extraire le texte et vectoriser
        console.log(`[Ingest] Trigger n8n avec URL: ${presignedUrl}`);
        
        const n8nPayload = {
            action: "ingest",
            bucket: MINIO_BUCKET,
            collection: QDRANT_COLLECTION,
            file_url: presignedUrl, // Lien direct pour n8n
            metadata: {
                filename: file.originalname,
                personaId: personaId,
                type: "file",
                mimeType: file.mimetype,
                minio_key: objectName
            }
        };

        const n8nRes = await fetch(N8N_QDRANT_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(n8nPayload)
        });

        if (!n8nRes.ok) throw new Error(`Erreur n8n: ${n8nRes.statusText}`);

        // D. Mise à jour de l'UI (JSON Local)
        const config = await readJson(PERSONAS_CONFIG_PATH, { personas: DEFAULT_PERSONAS });
        const p = config.personas.find(p => p.id === personaId);
        if (p) {
            p.knowledge = p.knowledge || [];
            // Éviter les doublons d'affichage
            p.knowledge = p.knowledge.filter(k => k.name !== file.originalname);
            p.knowledge.push({
                id: crypto.randomUUID(),
                name: file.originalname,
                type: 'file',
                date: new Date().toISOString(),
                minioKey: objectName
            });
            await writeJson(PERSONAS_CONFIG_PATH, config);
        }

        // Nettoyage du fichier temporaire local
        try { await fs.unlink(file.path); } catch {}

        res.json({ ok: true, message: "Fichier uploadé et transmis à n8n pour traitement." });

    } catch (e) {
        console.error("[Ingest Error]", e);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// 2. Ingestion de TEXTE (Note rapide)
app.post('/api/admin/personas/:personaId/knowledge/text', async (req, res) => {
    try {
        const { personaId } = req.params;
        const { title, content } = req.body;

        if (!title || !content) throw new Error("Titre et contenu requis");

        console.log(`[Ingest] Création note MinIO: ${title}`);

        // A. Création d'un fichier .txt virtuel dans MinIO
        const filename = `${title.replace(/[^a-z0-9]/gi, '_')}.txt`;
        const objectName = `${personaId}/${Date.now()}_${filename}`;
        const buffer = Buffer.from(content, 'utf-8');
        
        await minioClient.putObject(MINIO_BUCKET, objectName, buffer, buffer.length, {
            'Content-Type': 'text/plain'
        });

        // B. Lien temporaire
        const presignedUrl = await minioClient.presignedGetObject(MINIO_BUCKET, objectName, 24 * 60 * 60);

        // C. Envoi à n8n (Uniformisation : n8n traite toujours une URL de fichier)
        const n8nPayload = {
            action: "ingest",
            bucket: MINIO_BUCKET,
            collection: QDRANT_COLLECTION,
            file_url: presignedUrl,
            metadata: {
                filename: filename, 
                personaId: personaId,
                type: "text",
                title: title,
                minio_key: objectName
            }
        };

        await fetch(N8N_QDRANT_WEBHOOK, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(n8nPayload)
        });

        // D. Mise à jour UI
        const config = await readJson(PERSONAS_CONFIG_PATH, { personas: DEFAULT_PERSONAS });
        const p = config.personas.find(p => p.id === personaId);
        if (p) {
            p.knowledge = p.knowledge || [];
            p.knowledge = p.knowledge.filter(k => k.name !== title);
            p.knowledge.push({
                id: crypto.randomUUID(),
                name: title,
                type: 'text',
                date: new Date().toISOString(),
                minioKey: objectName
            });
            await writeJson(PERSONAS_CONFIG_PATH, config);
        }

        res.json({ ok: true });

    } catch (e) {
        console.error("[Ingest Text Error]", e);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// 3. Suppression (Déclenche le mode 'delete' du Webhook)
app.delete('/api/admin/personas/:personaId/knowledge/:filename', async (req, res) => {
    try {
        const { personaId, filename } = req.params;
        console.log(`[Delete] Suppression demandée pour ${filename}`);

        // A. Appel n8n (Action Delete)
        // On garde la logique de suppression Qdrant via n8n
        const n8nPayload = {
            action: "delete",
            bucket: MINIO_BUCKET,
            collection: QDRANT_COLLECTION,
            filename: filename,
            personaId: personaId
        };

        try {
            await fetch(N8N_QDRANT_WEBHOOK, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(n8nPayload)
            });
        } catch (n8nErr) {
            console.warn("[Delete Warning] n8n n'a pas répondu, nettoyage local quand même.");
        }

        // B. Nettoyage UI & MinIO
        const config = await readJson(PERSONAS_CONFIG_PATH, { personas: DEFAULT_PERSONAS });
        const p = config.personas.find(p => p.id === personaId);
        
        let minioKey = null;
        if (p && p.knowledge) {
            const doc = p.knowledge.find(k => k.name === filename || k.name === filename.replace('.txt', ''));
            
            if (doc) minioKey = doc.minioKey;
            p.knowledge = p.knowledge.filter(k => k.name !== filename && k.name !== filename.replace('.txt', ''));
            await writeJson(PERSONAS_CONFIG_PATH, config);
        }

        if (minioKey) {
            try { await minioClient.removeObject(MINIO_BUCKET, minioKey); } catch {}
        }

        res.json({ ok: true });

    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ==========================================
// ROUTES CLASSIQUES (Admin Personas, Chat)
// ==========================================

app.get('/api/admin/personas', async (req, res) => {
    res.json(await readJson(PERSONAS_CONFIG_PATH, { personas: DEFAULT_PERSONAS }));
});

app.post('/api/admin/personas', async (req, res) => {
    try {
        const persona = req.body;
        const config = await readJson(PERSONAS_CONFIG_PATH, { personas: DEFAULT_PERSONAS });
        const index = config.personas.findIndex(p => p.id === persona.id);
        if (index > -1) config.personas[index] = { ...config.personas[index], ...persona };
        else { persona.knowledge = []; config.personas.push(persona); }
        await writeJson(PERSONAS_CONFIG_PATH, config);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
});

app.delete('/api/admin/personas/:id', async (req, res) => {
    try {
        const config = await readJson(PERSONAS_CONFIG_PATH, { personas: DEFAULT_PERSONAS });
        config.personas = config.personas.filter(p => p.id !== req.params.id);
        await writeJson(PERSONAS_CONFIG_PATH, config);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok:false, error: e.message }); }
});

app.post('/api/chat/n8n', async (req, res) => {
    res.json({ ok: true, taskId: "simulated-task", status: "completed", data: { global_synthesis: "Message reçu.", responses: [] } });
});

app.get('/api/chat/task/:taskId', (req, res) => {
    res.json({ ok: true, status: 'completed', data: { global_synthesis: "Message reçu.", responses: [] } });
});

app.post('/api/gemini/persona', async (req, res) => {
    try {
        const { ministry } = req.body;
        const response = await fetch(GEMINI_URL, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ contents: [{ parts: [{ text: `Profil JSON ministre "${ministry}": {name, avatarEmoji, systemPrompt}` }] }] })
        });
        const json = await response.json();
        const text = json.candidates[0].content.parts[0].text.replace(/```json|```/g, '').trim();
        res.json({ ok: true, data: JSON.parse(text) });
    } catch(e) { res.status(500).json({ok:false}); }
});

app.get('/admin', (req, res) => res.render('admin'));
app.get('/', (req, res) => res.render('gouvgpt'));

app.listen(PORT, () => console.log(`\n🚀 GouvBrain Backend ready on port ${PORT}\n   Targeting n8n Webhook: ${N8N_QDRANT_WEBHOOK}`));