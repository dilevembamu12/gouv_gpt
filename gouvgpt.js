/**
 * gouvgpt.js — Orchestrateur Backend FinTraX
 * Mode: Stockage MinIO & Délégation n8n (Pure Ingestion & Chat Orchestré)
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
const N8N_CHAT_WEBHOOK = process.env.N8N_CHAT_WEBHOOK_URL || "http://192.168.12.75:5678/webhook/chat"; 
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

// --- Mémoire des Tâches (Pour gérer l'asynchrone du chat) ---
const taskStore = new Map();

// Nettoyage automatique des vieilles tâches (toutes les heures)
setInterval(() => {
    const now = Date.now();
    for (const [id, task] of taskStore.entries()) {
        if (now - task.timestamp > 3600000) taskStore.delete(id);
    }
}, 3600000);

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

const DATA_PATH = path.join(__dirname, 'public/data');
const PERSONAS_CONFIG_PATH = path.join(DATA_PATH, 'personas.config.json');
const ROOMS_DATA_PATH = path.join(DATA_PATH, 'rooms.json');
const DEFAULT_PERSONAS = [{ id: "pm", name: "Premier Ministre", role: "Chair", ministry: "Primature", color: "#22c55e", avatarEmoji: "🟢", systemPrompt: "Tu es le PM.", knowledge: [] }];

if (!fssync.existsSync(DATA_PATH)) fssync.mkdirSync(DATA_PATH, { recursive: true });

// ==========================================
// ROUTES DES SALONS (Rooms)
// ==========================================

app.post('/api/rooms', async (req, res) => {
    try {
        const { name, selectedPersonaIds } = req.body;
        const roomsData = await readJson(ROOMS_DATA_PATH, { rooms: [] });

        const newRoom = {
            id: crypto.randomUUID(),
            name: name || `Conseil du ${new Date().toLocaleDateString()}`,
            createdAt: new Date().toISOString(),
            activePersonas: selectedPersonaIds || [],
            files: [] 
        };

        roomsData.rooms.push(newRoom);
        await writeJson(ROOMS_DATA_PATH, roomsData);
        res.json({ ok: true, room: newRoom });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/rooms', async (req, res) => {
    res.json(await readJson(ROOMS_DATA_PATH, { rooms: [] }));
});

// ==========================================
// ROUTES CHAT (Communication n8n)
// ==========================================

app.post('/api/chat/n8n', async (req, res) => {
    try {
        const { roomId, message, model } = req.body;

        // 1. Récupérer les données du salon
        const roomsData = await readJson(ROOMS_DATA_PATH, { rooms: [] });
        const room = roomsData.rooms.find(r => r.id === roomId);
        if (!room) return res.status(404).json({ ok: false, error: "Salon introuvable" });

        // 2. Récupérer les experts (personas) configurés
        const config = await readJson(PERSONAS_CONFIG_PATH, { personas: DEFAULT_PERSONAS });
        const activeExperts = config.personas
            .filter(p => room.activePersonas.includes(p.id))
            .map(p => ({
                id: p.id,
                ministry_name: p.ministry,
                role_description: p.role || "Expert",
                emoji: p.avatarEmoji
            }));

        // 3. Préparer le payload structuré pour n8n
        const payloadForN8n = {
            question: message,
            room_id: roomId,
            model: model || "gpt-4o",
            orchestration_context: {
                available_experts: activeExperts,
                knowledge_base: room.files || [],
                timestamp: new Date().toISOString()
            }
        };

        const taskId = crypto.randomUUID();
        // Initialiser la tâche en "processing"
        taskStore.set(taskId, { status: 'processing', timestamp: Date.now() });

        // 4. Lancement asynchrone de la requête vers n8n
        (async () => {
            try {
                console.log(`[Chat] Envoi de la question vers n8n pour le salon ${roomId}...`);
                const n8nRes = await fetch(N8N_CHAT_WEBHOOK, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payloadForN8n)
                });

                // Lire la réponse en texte brut d'abord pour debug et éviter "Unexpected end of JSON input"
                const rawText = await n8nRes.text();

                if (!n8nRes.ok) {
                    throw new Error(`n8n HTTP ${n8nRes.status}: ${rawText.substring(0, 200)}`);
                }

                if (!rawText || rawText.trim() === "") {
                    throw new Error("Réponse vide reçue de n8n");
                }

                let rawResponse;
                try {
                    rawResponse = JSON.parse(rawText);
                } catch (parseError) {
                    throw new Error(`Réponse n8n invalide (non-JSON): ${rawText.substring(0, 100)}...`);
                }
                
                // On gère le format [ { ... } ] renvoyé par n8n (Tableau)
                // Si c'est un tableau, on prend le premier élément qui contient nos données (global_synthesis, responses, etc.)
                const resultData = Array.isArray(rawResponse) ? rawResponse[0] : rawResponse;

                console.log(`[Chat] Réponse valide reçue pour la tâche ${taskId}`);
                
                taskStore.set(taskId, { 
                    status: 'completed', 
                    data: resultData, 
                    timestamp: Date.now() 
                });
            } catch (err) {
                console.error(`[Chat Error] Problème avec n8n:`, err.message);
                taskStore.set(taskId, { status: 'error', error: err.message, timestamp: Date.now() });
            }
        })();

        // Répondre immédiatement avec l'ID de la tâche pour le polling
        res.json({ ok: true, taskId, status: 'processing' });
    } catch (e) {
        console.error("[Chat Route Error]", e);
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.get('/api/chat/task/:taskId', (req, res) => {
    const task = taskStore.get(req.params.taskId);
    if (!task) return res.status(404).json({ ok: false, status: 'not_found' });
    res.json({ ok: true, status: task.status, data: task.data, error: task.error });
});

// ==========================================
// ROUTES INGESTION (Node -> MinIO -> n8n)
// ==========================================

// 1. Ingestion de FICHIER (PDF/TXT/DOCX...)
app.post('/api/admin/personas/:personaId/knowledge/file', upload.single('file'), async (req, res) => {
    try {
        const { personaId } = req.params;
        const file = req.file;
        if (!file) throw new Error("Fichier manquant");

        const objectName = `${personaId}/${Date.now()}_${file.originalname}`;
        const fileStream = fssync.createReadStream(file.path);
        await minioClient.putObject(MINIO_BUCKET, objectName, fileStream, file.size, { 'Content-Type': file.mimetype });
        const presignedUrl = await minioClient.presignedGetObject(MINIO_BUCKET, objectName, 24 * 60 * 60);

        const n8nPayload = {
            action: "ingest",
            bucket: MINIO_BUCKET,
            collection: QDRANT_COLLECTION,
            file_url: presignedUrl,
            metadata: { filename: file.originalname, personaId, type: "file", mimeType: file.mimetype, minio_key: objectName }
        };

        const n8nRes = await fetch(N8N_QDRANT_WEBHOOK, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(n8nPayload)
        });

        if (!n8nRes.ok) throw new Error(`Erreur n8n: ${n8nRes.statusText}`);

        const config = await readJson(PERSONAS_CONFIG_PATH, { personas: DEFAULT_PERSONAS });
        const p = config.personas.find(p => p.id === personaId);
        if (p) {
            p.knowledge = p.knowledge || [];
            p.knowledge = p.knowledge.filter(k => k.name !== file.originalname);
            p.knowledge.push({ id: crypto.randomUUID(), name: file.originalname, type: 'file', date: new Date().toISOString(), minioKey: objectName });
            await writeJson(PERSONAS_CONFIG_PATH, config);
        }

        try { await fs.unlink(file.path); } catch {}
        res.json({ ok: true, message: "Fichier uploadé et transmis à n8n." });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 2. Ingestion de TEXTE (Note rapide)
app.post('/api/admin/personas/:personaId/knowledge/text', async (req, res) => {
    try {
        const { personaId, title, content } = req.body;
        const filename = `${title.replace(/[^a-z0-9]/gi, '_')}.txt`;
        const objectName = `${personaId}/${Date.now()}_${filename}`;
        const buffer = Buffer.from(content, 'utf-8');
        await minioClient.putObject(MINIO_BUCKET, objectName, buffer, buffer.length, { 'Content-Type': 'text/plain' });
        const presignedUrl = await minioClient.presignedGetObject(MINIO_BUCKET, objectName, 24 * 60 * 60);

        const n8nPayload = {
            action: "ingest", bucket: MINIO_BUCKET, collection: QDRANT_COLLECTION, file_url: presignedUrl,
            metadata: { filename, personaId, type: "text", title, minio_key: objectName }
        };

        await fetch(N8N_QDRANT_WEBHOOK, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(n8nPayload)
        });

        const config = await readJson(PERSONAS_CONFIG_PATH, { personas: DEFAULT_PERSONAS });
        const p = config.personas.find(p => p.id === personaId);
        if (p) {
            p.knowledge = p.knowledge || [];
            p.knowledge = p.knowledge.filter(k => k.name !== title);
            p.knowledge.push({ id: crypto.randomUUID(), name: title, type: 'text', date: new Date().toISOString(), minioKey: objectName });
            await writeJson(PERSONAS_CONFIG_PATH, config);
        }
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 3. Suppression
app.delete('/api/admin/personas/:personaId/knowledge/:filename', async (req, res) => {
    try {
        const { personaId, filename } = req.params;
        const n8nPayload = { action: "delete", bucket: MINIO_BUCKET, collection: QDRANT_COLLECTION, filename, personaId };
        try {
            await fetch(N8N_QDRANT_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(n8nPayload) });
        } catch (n8nErr) { console.warn("[Delete Warning] n8n injoignable."); }

        const config = await readJson(PERSONAS_CONFIG_PATH, { personas: DEFAULT_PERSONAS });
        const p = config.personas.find(p => p.id === personaId);
        let minioKey = null;
        if (p && p.knowledge) {
            const doc = p.knowledge.find(k => k.name === filename || k.name === filename.replace('.txt', ''));
            if (doc) minioKey = doc.minioKey;
            p.knowledge = p.knowledge.filter(k => k.name !== filename && k.name !== filename.replace('.txt', ''));
            await writeJson(PERSONAS_CONFIG_PATH, config);
        }
        if (minioKey) try { await minioClient.removeObject(MINIO_BUCKET, minioKey); } catch {}
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ==========================================
// ROUTES CLASSIQUES (Admin Personas)
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

app.listen(PORT, () => console.log(`\n🚀 GouvBrain Backend ready on port ${PORT}\n   Targeting n8n Chat: ${N8N_CHAT_WEBHOOK}\n   Targeting n8n Ingest: ${N8N_QDRANT_WEBHOOK}`));