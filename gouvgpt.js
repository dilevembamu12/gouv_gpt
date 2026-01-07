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

// Personas par défaut (si le fichier config n'existe pas)
const DEFAULT_PERSONAS = [
    { id: "pm", name: "Premier Ministre", role: "Chair", ministry: "Primature", n8n_webhook: "", color: "#22c55e", avatarEmoji: "🟢", description: "Arbitrage et synthèse." },
    { id: "fin", name: "Ministre des Finances", role: "SME", ministry: "Finances", n8n_webhook: "", color: "#f59e0b", avatarEmoji: "🟠", description: "Budget et soutenabilité." },
    { id: "just", name: "Ministre de la Justice", role: "SME", ministry: "Justice", n8n_webhook: "", color: "#ef4444", avatarEmoji: "🔴", description: "Légalité et conformité." },
    { id: "def", name: "Ministre de la Défense", role: "SME", ministry: "Défense", n8n_webhook: "", color: "#64748b", avatarEmoji: "⚫", description: "Sécurité et souveraineté." },
    { id: "sante", name: "Ministre de la Santé", role: "SME", ministry: "Santé", n8n_webhook: "", color: "#0ea5e9", avatarEmoji: "🔵", description: "Santé publique." }
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

// Initialisation du bucket au démarrage
(async () => {
  try {
    const exists = await minioClient.bucketExists(MINIO_BUCKET);
    if (!exists) {
      await minioClient.makeBucket(MINIO_BUCKET, 'us-east-1');
      console.log(`[MinIO] Bucket '${MINIO_BUCKET}' créé avec succès.`);
    } else {
      console.log(`[MinIO] Connecté au bucket '${MINIO_BUCKET}'.`);
    }
  } catch (err) {
    console.warn("[MinIO] Attention: Impossible de se connecter à MinIO (Mode dégradé).", err.message);
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

// Helpers JSON (Base de données fichier)
async function readJson(file, defaultVal) {
  try {
    const data = await fs.readFile(file, 'utf8');
    return JSON.parse(data);
  } catch { return defaultVal; }
}
async function writeJson(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

// --- ROUTES API : GESTION DES SALONS (ROOMS) ---

// Créer un salon avec sélection des personas
app.post('/api/rooms', async (req, res) => {
  try {
    const { name, selectedPersonaIds } = req.body;
    const roomId = crypto.randomUUID();
    
    // Charger la config des personas pour valider
    const config = await readJson(PERSONAS_CONFIG_PATH, { personas: DEFAULT_PERSONAS });
    const allIds = config.personas.map(p => p.id);
    
    // Si aucun sélectionné, on prend tout le monde par défaut
    const activePersonas = (selectedPersonaIds && selectedPersonaIds.length) ? selectedPersonaIds : allIds;

    const roomsData = await readJson(ROOMS_DATA_PATH, { rooms: [] });
    
    const newRoom = {
      id: roomId,
      name: name || `Conseil du ${new Date().toLocaleDateString()}`,
      createdAt: new Date().toISOString(),
      activePersonas: activePersonas,
      files: [] // Liste des documents RAG partagés dans ce salon
    };

    roomsData.rooms.push(newRoom);
    await writeJson(ROOMS_DATA_PATH, roomsData);

    res.json({ ok: true, room: newRoom });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- ROUTES API : INGESTION RAG (MinIO) ---

// Upload d'un fichier RAG dans un salon spécifique
app.post('/api/rooms/:roomId/ingest', upload.single('file'), async (req, res) => {
  try {
    const { roomId } = req.params;
    const file = req.file;
    if (!file) throw new Error("Aucun fichier reçu.");

    // 1. Upload vers MinIO
    // Structure: bucket/room_id/timestamp_filename
    const objectName = `${roomId}/${Date.now()}_${file.originalname}`;
    const fileStream = fssync.createReadStream(file.path);
    const stats = await fs.stat(file.path);
    
    let minioUrl = "";
    try {
      await minioClient.putObject(MINIO_BUCKET, objectName, fileStream, stats.size);
      // Générer une URL signée pour que n8n puisse récupérer le fichier
      // Valide 7 jours (ou configurez n8n avec les creds MinIO directement)
      minioUrl = await minioClient.presignedGetObject(MINIO_BUCKET, objectName, 7 * 24 * 60 * 60);
    } catch (err) {
      console.error("[Ingest] MinIO Error:", err.message);
      // Fallback local pour dev si MinIO n'est pas dispo
      minioUrl = `file://${file.path}`; 
    }

    // 2. Mettre à jour la Room dans rooms.json
    const roomsData = await readJson(ROOMS_DATA_PATH, { rooms: [] });
    const roomIndex = roomsData.rooms.findIndex(r => r.id === roomId);
    
    if (roomIndex === -1) throw new Error("Salon introuvable.");

    const newDoc = {
      id: crypto.randomUUID(),
      name: file.originalname,
      minioKey: objectName,
      downloadUrl: minioUrl,
      uploadedAt: new Date().toISOString(),
      visibleTo: 'all' // Pourrait être filtré par persona ici
    };

    roomsData.rooms[roomIndex].files.push(newDoc);
    await writeJson(ROOMS_DATA_PATH, roomsData);

    // Nettoyage temporaire (sauf si mode dev sans minio)
    if (!minioUrl.startsWith('file://')) {
        try { await fs.unlink(file.path); } catch {}
    }

    // 3. (Optionnel) Trigger un webhook "Systeme" n8n pour indexer immédiatement dans Qdrant
    // fetch(process.env.N8N_INDEXER_WEBHOOK, { ... })

    res.json({ ok: true, document: newDoc });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- ROUTES API : CHAT (Proxy vers n8n) ---

app.post('/api/chat/n8n', async (req, res) => {
  try {
    const { roomId, personaId, message } = req.body;
    
    // 1. Charger la config du Persona (pour avoir l'URL du webhook n8n)
    const config = await readJson(PERSONAS_CONFIG_PATH, { personas: [] });
    const persona = config.personas.find(p => p.id === personaId);
    
    if (!persona) throw new Error("Persona introuvable.");
    
    // 2. Charger le contexte du salon (fichiers RAG)
    const roomsData = await readJson(ROOMS_DATA_PATH, { rooms: [] });
    const room = roomsData.rooms.find(r => r.id === roomId);
    
    // Récupérer les URLs des fichiers pour que n8n puisse les lire
    const ragContext = room ? room.files.map(f => ({
        name: f.name,
        url: f.downloadUrl,
        key: f.minioKey
    })) : [];

    // Payload envoyé à n8n
    const payloadForN8n = {
      user_query: message,
      room_id: roomId,
      persona: {
        id: persona.id,
        name: persona.name,
        ministry: persona.ministry,
        system_prompt: persona.systemPrompt || "Tu es un expert gouvernemental."
      },
      // Le contexte RAG : n8n utilisera ces liens ou la clé MinIO pour vectoriser/chercher dans Qdrant
      rag_documents: ragContext 
    };

    console.log(`[n8n Proxy] Envoi vers ${persona.name} (${persona.n8n_webhook || 'Pas de webhook'})`);

    if (persona.n8n_webhook && persona.n8n_webhook.startsWith('http')) {
      const n8nRes = await fetch(persona.n8n_webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadForN8n)
      });
      
      if (!n8nRes.ok) throw new Error(`Erreur n8n: ${n8nRes.statusText}`);
      
      const json = await n8nRes.json();
      // On s'attend à une clé 'response' ou 'text' de n8n
      res.json({ ok: true, response: json.response || json.output || json.text || "Réponse vide de n8n." });
    } else {
      // Simulation si pas de webhook configuré
      res.json({ ok: true, response: `(Simulation ${persona.ministry}) Je n'ai pas de webhook n8n configuré, mais j'ai accès à ${ragContext.length} documents partagés.` });
    }

  } catch (e) {
    console.error(e);
    res.status(502).json({ ok: false, error: e.message });
  }
});

// --- ROUTES API : ADMINISTRATION ---

// Récupérer la config des personas
app.get('/api/admin/personas', async (req, res) => {
  const config = await readJson(PERSONAS_CONFIG_PATH, { personas: DEFAULT_PERSONAS });
  res.json(config);
});

// Mettre à jour la config des personas (URLs n8n, prompts)
app.post('/api/admin/personas', async (req, res) => {
  try {
    const newConfig = { personas: req.body.personas, updatedAt: new Date() };
    await writeJson(PERSONAS_CONFIG_PATH, newConfig);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ok: false, error: e.message});
  }
});

// --- SERVING VUES ---
app.get('/admin', (req, res) => res.render('admin'));
app.get('/', (req, res) => res.render('gouvgpt')); // Page principale (Salon)

// Lancement
app.listen(PORT, () => {
  console.log(`\n🚀 GouvBrain démarré sur http://localhost:${PORT}`);
  console.log(`🔧 Admin Panel sur http://localhost:${PORT}/admin`);
});