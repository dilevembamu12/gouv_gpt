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

// URL du Webhook Orchestrateur n8n défini par l'utilisateur
const N8N_CHAT_WEBHOOK = "https://n8n.fintrax.org/webhook/chat";

// --- 1. Configuration des Chemins & Stockage JSON ---
const PUBLIC_PATH = path.join(__dirname, 'public');
const DATA_PATH = path.join(PUBLIC_PATH, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

const PERSONAS_CONFIG_PATH = path.join(DATA_PATH, 'personas.config.json');
const ROOMS_DATA_PATH = path.join(DATA_PATH, 'rooms.json');

// Création des dossiers nécessaires
[DATA_PATH, UPLOADS_DIR].forEach(d => {
  if (!fssync.existsSync(d)) fssync.mkdirSync(d, { recursive: true });
});

// Personas par défaut
const DEFAULT_PERSONAS = [
    { id: "pm", name: "Premier Ministre", role: "Chair", ministry: "Primature", color: "#22c55e", avatarEmoji: "🟢" },
    { id: "fin", name: "Ministre des Finances", role: "SME", ministry: "Finances", color: "#f59e0b", avatarEmoji: "🟠" },
    { id: "just", name: "Ministre de la Justice", role: "SME", ministry: "Justice", color: "#ef4444", avatarEmoji: "🔴" },
    { id: "def", name: "Ministre de la Défense", role: "SME", ministry: "Défense", color: "#64748b", avatarEmoji: "⚫" },
    { id: "sante", name: "Ministre de la Santé", role: "SME", ministry: "Santé", color: "#0ea5e9", avatarEmoji: "🔵" }
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

// Initialisation du bucket
(async () => {
  try {
    const exists = await minioClient.bucketExists(MINIO_BUCKET);
    if (!exists) await minioClient.makeBucket(MINIO_BUCKET, 'us-east-1');
  } catch (err) {
    console.warn("[MinIO] Mode dégradé (Pas de connexion S3).", err.message);
  }
})();

// --- 3. Middleware ---
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(PUBLIC_PATH));

const upload = multer({ dest: UPLOADS_DIR });

// Helpers JSON
async function readJson(file, defaultVal) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return defaultVal; }
}
async function writeJson(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

// --- ROUTES API : SALONS ---

app.post('/api/rooms', async (req, res) => {
  try {
    const { name, selectedPersonaIds } = req.body;
    const config = await readJson(PERSONAS_CONFIG_PATH, { personas: DEFAULT_PERSONAS });
    const allIds = config.personas.map(p => p.id);
    const activePersonas = (selectedPersonaIds && selectedPersonaIds.length) ? selectedPersonaIds : allIds;

    const roomsData = await readJson(ROOMS_DATA_PATH, { rooms: [] });
    const newRoom = {
      id: crypto.randomUUID(),
      name: name || `Session du ${new Date().toLocaleDateString()}`,
      createdAt: new Date().toISOString(),
      activePersonas: activePersonas,
      files: [] 
    };

    roomsData.rooms.push(newRoom);
    await writeJson(ROOMS_DATA_PATH, roomsData);
    res.json({ ok: true, room: newRoom });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- ROUTES API : INGESTION RAG ---

app.post('/api/rooms/:roomId/ingest', upload.single('file'), async (req, res) => {
  try {
    const { roomId } = req.params;
    const file = req.file;
    if (!file) throw new Error("Aucun fichier.");

    const objectName = `${roomId}/${Date.now()}_${file.originalname}`;
    const fileStream = fssync.createReadStream(file.path);
    const stats = await fs.stat(file.path);
    
    let minioUrl = "";
    try {
      await minioClient.putObject(MINIO_BUCKET, objectName, fileStream, stats.size);
      // URL signée valable 24h pour n8n
      minioUrl = await minioClient.presignedGetObject(MINIO_BUCKET, objectName, 24*60*60);
    } catch (err) {
      console.error("[MinIO] Error:", err.message);
      minioUrl = `file://${file.path}`; 
    }

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

    if (!minioUrl.startsWith('file://')) try { await fs.unlink(file.path); } catch {}

    res.json({ ok: true, document: newDoc });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- ROUTES API : CHAT ORCHESTRÉ (Nouveau) ---

app.post('/api/chat/n8n', async (req, res) => {
  try {
    // 1. Récupération des données envoyées par le frontend
    const { roomId, message, activeMinistriesIds, model } = req.body;
    
    // 2. Chargement des données contextuelles (Config & Salon)
    const config = await readJson(PERSONAS_CONFIG_PATH, { personas: DEFAULT_PERSONAS });
    const roomsData = await readJson(ROOMS_DATA_PATH, { rooms: [] });
    const room = roomsData.rooms.find(r => r.id === roomId);
    
    if (!room) throw new Error("Salon expiré ou introuvable.");

    // 3. Construction des listes de ministères
    // A) Ministères présents dans le salon (Scope global)
    const participatingMinistries = config.personas
        .filter(p => room.activePersonas.includes(p.id))
        .map(p => ({
            id: p.id,
            name: p.name,
            ministry: p.ministry,
            role: p.role,
            system_prompt: p.systemPrompt || "Expert gouvernemental."
        }));

    // B) Ministères actifs pour CETTE question (si spécifié par l'UI, sinon tous)
    const targetIds = (activeMinistriesIds && activeMinistriesIds.length) ? activeMinistriesIds : room.activePersonas;
    const activeMinistries = participatingMinistries.filter(p => targetIds.includes(p.id));

    // 4. Gestion du fichier joint (On prend le dernier uploadé pour le contexte immédiat, ou tous)
    // Ici on envoie la liste complète des fichiers du salon pour le RAG
    const ragFiles = room.files.map(f => ({
        filename: f.name,
        url: f.downloadUrl,
        uploaded_at: f.uploadedAt
    }));

    // 5. Construction du Payload exact demandé par n8n
    const payloadForN8n = {
        question: message,
        model: model || "gpt-4o", // Défaut si non spécifié
        room_id: roomId,
        exchange_context: {
            participating_ministries: participatingMinistries, // Tous les présents
            active_ministries: activeMinistries,               // Ceux qui doivent répondre
            all_files: ragFiles,                               // Contexte global RAG
            last_file: ragFiles.length > 0 ? ragFiles[ragFiles.length - 1] : null // Le dernier fichier (focus)
        },
        timestamp: new Date().toISOString()
    };

    console.log(`[Orchestrateur] Envoi vers ${N8N_CHAT_WEBHOOK}`);
    console.log(`[Orchestrateur] Question: "${message.substring(0, 50)}..." | Ministres actifs: ${activeMinistries.length}`);

    // 6. Appel au Webhook Unique n8n
    const n8nRes = await fetch(N8N_CHAT_WEBHOOK, {
        method: 'POST',
        headers: { 
            'Content-Type': 'application/json',
            'X-GouvBrain-Source': 'node-backend'
        },
        body: JSON.stringify(payloadForN8n)
    });

    if (!n8nRes.ok) {
        const errTxt = await n8nRes.text();
        throw new Error(`Erreur n8n (${n8nRes.status}): ${errTxt.substring(0, 200)}`);
    }

    const jsonResponse = await n8nRes.json();
    
    // 7. Renvoi au Frontend
    // On s'attend à ce que n8n renvoie un tableau de réponses ou une réponse consolidée
    res.json({ 
        ok: true, 
        data: jsonResponse 
    });

  } catch (e) {
    console.error("[Chat Error]", e);
    res.status(502).json({ ok: false, error: "Le conseil est momentanément indisponible.", details: e.message });
  }
});

// --- ADMIN & VIEWS ---
app.get('/api/admin/personas', async (req, res) => res.json(await readJson(PERSONAS_CONFIG_PATH, { personas: DEFAULT_PERSONAS })));
app.get('/admin', (req, res) => res.render('admin'));
app.get('/', (req, res) => res.render('gouvgpt'));

app.listen(PORT, () => console.log(`\n🏛️  GouvBrain Orchestrator running on port ${PORT}`));