/**
 * gouvgpt.js — Orchestrateur Backend FinTraX
 * Stack: Node.js + Express + MinIO + n8n Proxy
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

// Configuration du Webhook n8n (Orchestrateur)
const N8N_CHAT_WEBHOOK = process.env.N8N_CHAT_WEBHOOK_URL || "https://n8n.fintrax.org/webhook/chat";

// --- 1. Configuration Chemins & Données ---
const PUBLIC_PATH = path.join(__dirname, 'public');
const DATA_PATH = path.join(PUBLIC_PATH, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PERSONAS_CONFIG_PATH = path.join(DATA_PATH, 'personas.config.json');
const ROOMS_DATA_PATH = path.join(DATA_PATH, 'rooms.json');

[DATA_PATH, UPLOADS_DIR].forEach(d => {
  if (!fssync.existsSync(d)) fssync.mkdirSync(d, { recursive: true });
});

const DEFAULT_PERSONAS = [
    { id: "pm", name: "Premier Ministre", role: "Chair", ministry: "Primature", color: "#22c55e", avatarEmoji: "🟢" },
    { id: "fin", name: "Ministre des Finances", role: "SME", ministry: "Finances", color: "#f59e0b", avatarEmoji: "🟠" },
    { id: "just", name: "Ministre de la Justice", role: "SME", ministry: "Justice", color: "#ef4444", avatarEmoji: "🔴" },
    { id: "def", name: "Ministre de la Défense", role: "SME", ministry: "Défense", color: "#64748b", avatarEmoji: "⚫" }
];

// --- 2. Initialisation MinIO (S3) ---
const minioClient = new Minio.Client({
  endPoint: process.env.MINIO_ENDPOINT || 'localhost',
  port: Number(process.env.MINIO_PORT || 9000),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin'
});
const MINIO_BUCKET = process.env.MINIO_BUCKET || 'gouvbrain-rag-docs';

(async () => {
  try {
    if (!(await minioClient.bucketExists(MINIO_BUCKET))) {
      await minioClient.makeBucket(MINIO_BUCKET, 'us-east-1');
    }
  } catch (err) { console.warn("[MinIO] Warning:", err.message); }
})();

// --- 3. Middleware ---
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(PUBLIC_PATH));

const upload = multer({ dest: UPLOADS_DIR });

async function readJson(file, defaultVal) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return defaultVal; }
}
async function writeJson(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

// --- ROUTES API ---

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

// 2. Ingestion RAG (Upload)
app.post('/api/rooms/:roomId/ingest', upload.single('file'), async (req, res) => {
  try {
    const { roomId } = req.params;
    const file = req.file;
    if (!file) throw new Error("Aucun fichier.");

    const objectName = `${roomId}/${Date.now()}_${file.originalname}`;
    
    // Upload MinIO
    await minioClient.putObject(MINIO_BUCKET, objectName, fssync.createReadStream(file.path), file.size);
    const minioUrl = await minioClient.presignedGetObject(MINIO_BUCKET, objectName, 24*60*60);

    // Update Room
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

// 3. ROUTE CHAT UNIQUE (Orchestrateur n8n)
app.post('/api/chat/n8n', async (req, res) => {
  try {
    const { roomId, message, model } = req.body;
    
    // Charger le contexte du salon
    const config = await readJson(PERSONAS_CONFIG_PATH, { personas: DEFAULT_PERSONAS });
    const roomsData = await readJson(ROOMS_DATA_PATH, { rooms: [] });
    const room = roomsData.rooms.find(r => r.id === roomId);
    
    if (!room) throw new Error("Salon introuvable.");

    // Construire la liste des "Experts" présents dans ce salon
    const activeMinistries = config.personas
        .filter(p => room.activePersonas.includes(p.id))
        .map(p => ({
            id: p.id,
            ministry_name: p.ministry,
            role_description: p.systemPrompt || p.description || "Expert",
            emoji: p.avatarEmoji
        }));

    // Construire la liste des fichiers disponibles pour le RAG
    const ragContext = room.files.map(f => ({
        filename: f.name,
        url: f.downloadUrl,
        type: f.type
    }));

    // Payload envoyé à n8n
    const payloadForN8n = {
        question: message,
        room_id: roomId,
        model: model || "gpt-4o",
        // Tout le contexte nécessaire pour que l'agent n8n décide
        orchestration_context: {
            available_experts: activeMinistries, // Qui est autour de la table ?
            knowledge_base: ragContext,          // Quels dossiers sont sur la table ?
            timestamp: new Date().toISOString()
        }
    };

    console.log(`[Orchestrateur] Envoi de la question "${message}" à n8n (${activeMinistries.length} experts).`);

    // Appel Webhook
    // Note: Utilisation de fetch natif (Node 18+)
    const n8nRes = await fetch(N8N_CHAT_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadForN8n)
    });

    if (!n8nRes.ok) throw new Error(`n8n Error: ${n8nRes.statusText}`);
    
    const jsonResponse = await n8nRes.json();
    
    // n8n doit renvoyer un JSON de type: 
    // { "responses": [ { "ministry": "Finances", "text": "..." }, { "ministry": "Justice", "text": "..." } ] }
    res.json({ ok: true, data: jsonResponse });

  } catch (e) {
    console.error("[Chat Error]", e);
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.get('/api/admin/personas', async (req, res) => res.json(await readJson(PERSONAS_CONFIG_PATH, { personas: DEFAULT_PERSONAS })));
app.get('/admin', (req, res) => res.render('admin'));
app.get('/', (req, res) => res.render('gouvgpt'));

app.listen(PORT, () => console.log(`\n🏛️  GouvBrain Orchestrator running on port ${PORT}`));