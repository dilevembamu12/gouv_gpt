/**
 * gouvgpt.js — Orchestrateur Backend FinTraX
 * Mode: Admin & Gestion de la Connaissance Permanente (Qdrant)
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

// Webhooks n8n
const N8N_CHAT_WEBHOOK = process.env.N8N_CHAT_WEBHOOK_URL;
const N8N_INGEST_WEBHOOK = process.env.N8N_INGEST_WEBHOOK_URL || "https://n8n.fintrax.org/webhook/ingest";

// --- Mémoire des Tâches (Pour gérer l'asynchrone) ---
const taskStore = new Map();

// Nettoyage automatique des vieilles tâches (toutes les heures)
setInterval(() => {
    const now = Date.now();
    for (const [id, task] of taskStore.entries()) {
        if (now - task.timestamp > 3600000) taskStore.delete(id); // 1h TTL
    }
}, 3600000);

const PUBLIC_PATH = path.join(__dirname, 'public');
const DATA_PATH = path.join(PUBLIC_PATH, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PERSONAS_CONFIG_PATH = path.join(DATA_PATH, 'personas.config.json');
const ROOMS_DATA_PATH = path.join(DATA_PATH, 'rooms.json');

[DATA_PATH, UPLOADS_DIR].forEach(d => { if (!fssync.existsSync(d)) fssync.mkdirSync(d, { recursive: true }); });

const DEFAULT_PERSONAS = [
    { id: "pm", name: "Premier Ministre", role: "Chair", ministry: "Primature", color: "#22c55e", avatarEmoji: "🟢", systemPrompt: "Tu es le Premier Ministre. Tu arbitres les débats.", knowledge: [] },
    { id: "fin", name: "Ministre des Finances", role: "SME", ministry: "Finances", color: "#f59e0b", avatarEmoji: "🟠", systemPrompt: "Tu es le Ministre des Finances. Ton focus est le budget.", knowledge: [] },
    { id: "just", name: "Ministre de la Justice", role: "SME", ministry: "Justice", color: "#ef4444", avatarEmoji: "🔴", systemPrompt: "Tu es le Garde des Sceaux. Rappelle le droit.", knowledge: [] },
    { id: "def", name: "Ministre de la Défense", role: "SME", ministry: "Défense", color: "#64748b", avatarEmoji: "⚫", systemPrompt: "Tu es le Ministre de la Défense. Sécurité nationale avant tout.", knowledge: [] }
];

// --- MinIO ---
const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT || 'localhost',
  port: Number(process.env.MINIO_PORT || 9000),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin'
});
const MINIO_BUCKET = process.env.MINIO_BUCKET || 'gouvbrain-permanent-knowledge';

(async () => {
    try {
        if (!(await minioClient.bucketExists(MINIO_BUCKET))) {
            await minioClient.makeBucket(MINIO_BUCKET, 'us-east-1');
        }
    } catch (err) { console.warn("[MinIO] Warning:", err.message); }
})();

// --- HELPERS ---
async function readJson(file, defaultVal) {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return defaultVal; }
}
async function writeJson(file, data) {
    await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.set('view engine', 'ejs');
app.use(express.static(PUBLIC_PATH));
const upload = multer({ dest: UPLOADS_DIR });

// --- ROUTES API CHAT & ROOMS (Existantes) ---

// 1. Création Salon
app.post('/api/rooms', async (req, res) => {
    try {
        const { name, selectedPersonaIds } = req.body;
        const config = await readJson(PERSONAS_CONFIG_PATH, { personas: DEFAULT_PERSONAS });
        const allIds = config.personas.map(p => p.id);
        const activePersonas = (selectedPersonaIds && selectedPersonaIds.length) ? selectedPersonaIds : allIds;

        const roomsData = await readJson(ROOMS_DATA_PATH, { rooms: [] });
        const newRoom = {
            id: crypto.randomUUID(),
            name: name || `Conseil du ${new Date().toLocaleDateString()}`,
            createdAt: new Date().toISOString(),
            activePersonas: activePersonas,
            files: [] 
        };

        roomsData.rooms.push(newRoom);
        await writeJson(ROOMS_DATA_PATH, roomsData);
        res.json({ ok: true, room: newRoom });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 2. Ingestion RAG TEMPORAIRE (Upload session)
app.post('/api/rooms/:roomId/ingest', upload.single('file'), async (req, res) => {
    try {
        const { roomId } = req.params;
        const file = req.file;
        if (!file) throw new Error("Aucun fichier.");

        const objectName = `${roomId}/${Date.now()}_${file.originalname}`;
        await minioClient.putObject(MINIO_BUCKET, objectName, fssync.createReadStream(file.path), file.size);
        const minioUrl = await minioClient.presignedGetObject(MINIO_BUCKET, objectName, 24*60*60);

        const roomsData = await readJson(ROOMS_DATA_PATH, { rooms: [] });
        const room = roomsData.rooms.find(r => r.id === roomId);
        if (!room) throw new Error("Salon introuvable.");

        const newDoc = {
            id: crypto.randomUUID(),
            name: file.originalname,
            minioKey: objectName,
            downloadUrl: minioUrl,
            type: file.mimetype,
            uploadedAt: new Date().toISOString()
        };
        room.files.push(newDoc);
        await writeJson(ROOMS_DATA_PATH, roomsData);

        try { await fs.unlink(file.path); } catch {}
        res.json({ ok: true, document: newDoc });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 3. ROUTE CHAT ASYNCHRONE
app.post('/api/chat/n8n', async (req, res) => {
    try {
        const { roomId, message, model } = req.body;
        
        const config = await readJson(PERSONAS_CONFIG_PATH, { personas: DEFAULT_PERSONAS });
        const roomsData = await readJson(ROOMS_DATA_PATH, { rooms: [] });
        const room = roomsData.rooms.find(r => r.id === roomId);
        if (!room) throw new Error("Salon introuvable.");

        const activeMinistries = config.personas
            .filter(p => room.activePersonas.includes(p.id))
            .map(p => ({
                id: p.id,
                ministry_name: p.ministry,
                role_description: p.systemPrompt || p.description || "Expert",
                emoji: p.avatarEmoji
            }));

        const ragContext = room.files.map(f => ({
            filename: f.name,
            url: f.downloadUrl,
            type: f.type
        }));

        const payloadForN8n = {
            question: message,
            room_id: roomId,
            model: model || "gpt-4o",
            orchestration_context: {
                available_experts: activeMinistries,
                knowledge_base: ragContext,
                timestamp: new Date().toISOString()
            }
        };

        const taskId = crypto.randomUUID();
        taskStore.set(taskId, { status: 'processing', timestamp: Date.now() });

        (async () => {
            try {
                console.log(`[Tâche ${taskId}] Envoi à n8n (Async)...`);
                const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
                
                const n8nRes = await fetch(N8N_CHAT_WEBHOOK, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payloadForN8n)
                });

                if (!n8nRes.ok) throw new Error(`n8n HTTP ${n8nRes.status}`);
                const jsonResponse = await n8nRes.json();
                
                taskStore.set(taskId, { 
                    status: 'completed', 
                    data: jsonResponse, 
                    timestamp: Date.now() 
                });
                console.log(`[Tâche ${taskId}] Succès n8n.`);
            } catch (err) {
                console.error(`[Tâche ${taskId}] Erreur n8n:`, err.message);
                taskStore.set(taskId, { status: 'error', error: err.message, timestamp: Date.now() });
            }
        })();

        res.json({ ok: true, taskId: taskId, status: 'processing' });
    } catch (e) {
        console.error("[Chat Error]", e);
        res.status(502).json({ ok: false, error: e.message });
    }
});

// 4. ROUTE DE POLLING
app.get('/api/chat/task/:taskId', (req, res) => {
    const { taskId } = req.params;
    const task = taskStore.get(taskId);
    if (!task) return res.status(404).json({ ok: false, status: 'not_found' });
    res.json({ ok: true, status: task.status, data: task.data, error: task.error });
});

// --- NOUVELLES ROUTES PERSONAS (CRUD ADMIN) ---

// Lister les personas
app.get('/api/admin/personas', async (req, res) => {
    const config = await readJson(PERSONAS_CONFIG_PATH, { personas: DEFAULT_PERSONAS });
    res.json(config);
});

// Créer ou mettre à jour un persona
app.post('/api/admin/personas', async (req, res) => {
    try {
        const persona = req.body; // { id, name, ministry, avatarEmoji, systemPrompt... }
        const config = await readJson(PERSONAS_CONFIG_PATH, { personas: DEFAULT_PERSONAS });
        
        const index = config.personas.findIndex(p => p.id === persona.id);
        if (index > -1) {
            // Merge pour ne pas écraser les champs non envoyés (comme knowledge)
            config.personas[index] = { ...config.personas[index], ...persona };
        } else {
            persona.id = persona.id || crypto.randomUUID();
            persona.knowledge = persona.knowledge || [];
            config.personas.push(persona);
        }
        
        await writeJson(PERSONAS_CONFIG_PATH, config);
        res.json({ ok: true, persona });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Supprimer un persona
app.delete('/api/admin/personas/:id', async (req, res) => {
    try {
        const config = await readJson(PERSONAS_CONFIG_PATH, { personas: DEFAULT_PERSONAS });
        config.personas = config.personas.filter(p => p.id !== req.params.id);
        await writeJson(PERSONAS_CONFIG_PATH, config);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// --- INGESTION CONNAISSANCE PERMANENTE (Vers n8n -> Qdrant) ---
app.post('/api/admin/personas/:id/knowledge', upload.single('file'), async (req, res) => {
    try {
        const personaId = req.params.id;
        const file = req.file;
        if (!file) throw new Error("Fichier manquant.");

        const objectName = `permanent/${personaId}/${Date.now()}_${file.originalname}`;
        await minioClient.putObject(MINIO_BUCKET, objectName, fssync.createReadStream(file.path), file.size);
        const downloadUrl = await minioClient.presignedGetObject(MINIO_BUCKET, objectName, 24*60*60);

        // Appel n8n pour indexation permanente
        console.log(`[Admin] Indexation Qdrant pour ${personaId}: ${file.originalname}`);
        
        const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
        // Note: N8N_INGEST_WEBHOOK doit être configuré pour recevoir { url, personaId, type: 'permanent' }
        // Et stocker le vecteur dans Qdrant avec un filtre metadonnée 'personaId'
        
        // On rend l'appel non-bloquant pour l'UI, ou bloquant si on veut confirmer l'ingestion
        // Ici on fait un "fire and forget" vers n8n mais on attend au moins le ACK
        try {
             await fetch(N8N_INGEST_WEBHOOK, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: downloadUrl,
                    personaId: personaId, // Pour filtrage Qdrant
                    filename: file.originalname,
                    type: "permanent"
                })
            });
        } catch (err) {
            console.error("[Ingest Error] n8n unreachable", err);
            // On continue quand même pour sauver l'entrée en base locale
        }

        // Enregistrer dans la config locale pour l'historique
        const config = await readJson(PERSONAS_CONFIG_PATH, { personas: DEFAULT_PERSONAS });
        const p = config.personas.find(p => p.id === personaId);
        if (p) {
            p.knowledge = p.knowledge || [];
            p.knowledge.push({ 
                id: crypto.randomUUID(), 
                name: file.originalname, 
                date: new Date().toISOString(),
                minioKey: objectName
            });
            await writeJson(PERSONAS_CONFIG_PATH, config);
        }

        try { await fs.unlink(file.path); } catch {}
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// --- VIEWS ---
app.get('/admin', (req, res) => res.render('admin'));
app.get('/', (req, res) => res.render('gouvgpt'));

app.listen(PORT, () => console.log(`\n⚙️  GouvBrain Admin ready on port ${PORT}`));