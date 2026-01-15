/**
 * gouvgpt.js — Orchestrateur Backend FinTraX
 * Mode: Persistance JSON Locale Complète + MinIO + n8n (Logs Renforcés)
 * Hybrid Task Store: Memory (Primary) + Disk (Backup)
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

// --- CHEMINS DE DONNÉES ---
const PUBLIC_PATH = path.join(__dirname, 'public');
const DATA_PATH = path.join(PUBLIC_PATH, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PERSONAS_CONFIG_PATH = path.join(DATA_PATH, 'personas.config.json');
const ROOMS_DATA_PATH = path.join(DATA_PATH, 'rooms.json');
const TASKS_DATA_PATH = path.join(DATA_PATH, 'tasks.json');

// --- DONNÉES PAR DÉFAUT ---
const DEFAULT_PERSONAS_DATA = {
    personas: [
        { 
            id: "pm", 
            name: "Premier Ministre", 
            role: "Chair", 
            ministry: "Primature", 
            color: "#22c55e", 
            avatarEmoji: "🟢", 
            systemPrompt: "Tu es le Premier Ministre. Tu arbitres les débats et donnes la vision globale.", 
            knowledge: [] 
        },
        { 
            id: "fin", 
            name: "Ministre des Finances", 
            role: "SME", 
            ministry: "Finances", 
            color: "#f59e0b", 
            avatarEmoji: "🟠", 
            systemPrompt: "Tu es le Ministre des Finances. Ton focus est la rigueur budgétaire.", 
            knowledge: [] 
        }
    ]
};

const DEFAULT_ROOMS_DATA = { rooms: [] };
const DEFAULT_TASKS_DATA = { tasks: [] };

// --- GESTIONNAIRE DE TÂCHES HYBRIDE (MÉMOIRE + DISQUE) ---
// La Map en mémoire est la source de vérité pour la rapidité.
// Le fichier JSON sert uniquement de sauvegarde en cas de redémarrage.
const taskStore = new Map();

async function initDataFiles() {
    [DATA_PATH, UPLOADS_DIR].forEach(d => { 
        if (!fssync.existsSync(d)) {
            fssync.mkdirSync(d, { recursive: true });
            console.log(`[Init] Dossier créé : ${d}`);
        } 
    });

    const filesToInit = [
        { path: PERSONAS_CONFIG_PATH, default: DEFAULT_PERSONAS_DATA, name: "Personas" },
        { path: ROOMS_DATA_PATH, default: DEFAULT_ROOMS_DATA, name: "Rooms" },
        { path: TASKS_DATA_PATH, default: DEFAULT_TASKS_DATA, name: "Tasks" }
    ];

    for (const file of filesToInit) {
        if (!fssync.existsSync(file.path)) {
            await writeJson(file.path, file.default);
            console.log(`[Init] Base ${file.name} créée : ${file.path}`);
        }
    }

    // CHARGEMENT DES TÂCHES AU DÉMARRAGE
    try {
        const savedTasks = await readJson(TASKS_DATA_PATH, DEFAULT_TASKS_DATA);
        if (savedTasks && Array.isArray(savedTasks.tasks)) {
            savedTasks.tasks.forEach(t => taskStore.set(t.id, t));
            console.log(`[Init] ${taskStore.size} tâches restaurées en mémoire.`);
        }
    } catch (e) {
        console.warn("[Init] Impossible de restaurer les tâches:", e.message);
    }
}

// Fonction pour mettre à jour une tâche (Mémoire + Disque)
async function updateTask(taskId, updateData) {
    // 1. Mise à jour Mémoire (Immédiat)
    const currentTask = taskStore.get(taskId) || { id: taskId, createdAt: new Date().toISOString() };
    const newTask = { ...currentTask, ...updateData, updatedAt: new Date().toISOString() };
    taskStore.set(taskId, newTask);

    // 2. Persistance Disque (Asynchrone / Non-bloquant pour l'API)
    // On ne 'await' pas forcément cette partie pour ne pas ralentir la réponse HTTP,
    // sauf si la cohérence disque stricte est requise. Ici, on veut la vitesse.
    saveTasksToDisk(); 
}

// Fonction de récupération (Mémoire uniquement = Très rapide)
function getTask(taskId) {
    return taskStore.get(taskId);
}

// Sauvegarde périodique ou déclenchée
async function saveTasksToDisk() {
    try {
        // Conversion Map -> Array
        const tasksArray = Array.from(taskStore.values());
        
        // Nettoyage : on ne garde que les tâches récentes sur le disque (< 24h par ex) pour ne pas exploser le fichier
        const oneDayAgo = new Date(Date.now() - 86400000);
        const activeTasks = tasksArray.filter(t => new Date(t.createdAt) > oneDayAgo);

        await writeJson(TASKS_DATA_PATH, { tasks: activeTasks });
    } catch (e) {
        console.error("[Disk Save Error]", e.message);
    }
}


// --- Helpers JSON ---
async function readJson(file, defaultVal) {
    try { 
        const data = await fs.readFile(file, 'utf8');
        return JSON.parse(data); 
    } catch (e) { 
        console.warn(`[Warn] Echec lecture ${file}, utilisation défaut.`);
        return defaultVal; 
    }
}

async function writeJson(file, data) {
    await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}


// --- CONFIGURATION WEBHOOKS & APIs ---
const N8N_QDRANT_WEBHOOK = process.env.N8N_QDRANT_WEBHOOK || "http://192.168.12.75:5678/webhook-test/qdrant-ops";
const N8N_CHAT_WEBHOOK = process.env.N8N_CHAT_WEBHOOK_URL; 
const QDRANT_COLLECTION = "gouvbrain_knowledge";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${GEMINI_API_KEY}`;
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// --- MINIO ---
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
        if (!exists) await minioClient.makeBucket(MINIO_BUCKET, 'us-east-1');
    } catch (err) { console.warn("[MinIO] Warning:", err.message); }
})();

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ dest: path.join(__dirname, 'uploads') });

// ==========================================
// ROUTES API (PERSONAS & ROOMS)
// ==========================================

app.get('/api/admin/personas', async (req, res) => {
    const data = await readJson(PERSONAS_CONFIG_PATH, DEFAULT_PERSONAS_DATA);
    res.json(data);
});

app.post('/api/admin/personas', async (req, res) => {
    try {
        const persona = req.body;
        const config = await readJson(PERSONAS_CONFIG_PATH, DEFAULT_PERSONAS_DATA);
        const index = config.personas.findIndex(p => p.id === persona.id);
        
        if (index > -1) {
            config.personas[index] = { ...config.personas[index], ...persona };
        } else {
            persona.id = persona.id || crypto.randomUUID();
            persona.knowledge = [];
            config.personas.push(persona);
        }
        await writeJson(PERSONAS_CONFIG_PATH, config);
        res.json({ ok: true, persona });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.delete('/api/admin/personas/:id', async (req, res) => {
    try {
        const config = await readJson(PERSONAS_CONFIG_PATH, DEFAULT_PERSONAS_DATA);
        config.personas = config.personas.filter(p => p.id !== req.params.id);
        await writeJson(PERSONAS_CONFIG_PATH, config);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/rooms', async (req, res) => {
    const data = await readJson(ROOMS_DATA_PATH, DEFAULT_ROOMS_DATA);
    data.rooms.reverse();
    res.json(data);
});

app.get('/api/rooms/:id', async (req, res) => {
    const data = await readJson(ROOMS_DATA_PATH, DEFAULT_ROOMS_DATA);
    const room = data.rooms.find(r => r.id === req.params.id);
    if (!room) return res.status(404).json({ ok: false, error: "Salon introuvable" });
    res.json({ ok: true, room });
});

app.post('/api/rooms', async (req, res) => {
    try {
        const { name, selectedPersonaIds } = req.body;
        const roomsData = await readJson(ROOMS_DATA_PATH, DEFAULT_ROOMS_DATA);
        const newRoom = {
            id: crypto.randomUUID(),
            name: name || `Conseil du ${new Date().toLocaleDateString()}`,
            createdAt: new Date().toISOString(),
            activePersonas: selectedPersonaIds || [],
            files: [],
            messages: [] 
        };
        roomsData.rooms.push(newRoom);
        await writeJson(ROOMS_DATA_PATH, roomsData);
        res.json({ ok: true, room: newRoom });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ==========================================
// ROUTES INGESTION (Node -> MinIO -> n8n)
// ==========================================
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
            action: "ingest", bucket: MINIO_BUCKET, collection: QDRANT_COLLECTION, file_url: presignedUrl,
            metadata: { filename: file.originalname, personaId, type: "file", mimeType: file.mimetype, minio_key: objectName }
        };
        await fetch(N8N_QDRANT_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(n8nPayload) });

        const config = await readJson(PERSONAS_CONFIG_PATH, DEFAULT_PERSONAS_DATA);
        const p = config.personas.find(p => p.id === personaId);
        if (p) {
            p.knowledge = p.knowledge || [];
            p.knowledge = p.knowledge.filter(k => k.name !== file.originalname);
            p.knowledge.push({ id: crypto.randomUUID(), name: file.originalname, type: 'file', date: new Date().toISOString(), minioKey: objectName });
            await writeJson(PERSONAS_CONFIG_PATH, config);
        }
        try { await fs.unlink(file.path); } catch {}
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

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
        await fetch(N8N_QDRANT_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(n8nPayload) });

        const config = await readJson(PERSONAS_CONFIG_PATH, DEFAULT_PERSONAS_DATA);
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

app.delete('/api/admin/personas/:personaId/knowledge/:filename', async (req, res) => {
    try {
        const { personaId, filename } = req.params;
        const n8nPayload = { action: "delete", bucket: MINIO_BUCKET, collection: QDRANT_COLLECTION, filename, personaId };
        try { await fetch(N8N_QDRANT_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(n8nPayload) }); } catch (n8nErr) {}
        
        const config = await readJson(PERSONAS_CONFIG_PATH, DEFAULT_PERSONAS_DATA);
        const p = config.personas.find(p => p.id === personaId);
        let minioKey = null;
        if (p && p.knowledge) {
            const doc = p.knowledge.find(k => k.name === filename || k.name === filename.replace('.txt', ''));
            if(doc) minioKey = doc.minioKey;
            p.knowledge = p.knowledge.filter(k => k.name !== filename && k.name !== filename.replace('.txt', ''));
            await writeJson(PERSONAS_CONFIG_PATH, config);
        }
        if(minioKey) try { await minioClient.removeObject(MINIO_BUCKET, minioKey); } catch {}
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});


// ==========================================
// ROUTES CHAT (PERSISTANCE AMÉLIORÉE - TASKS.JSON)
// ==========================================

app.post('/api/chat/n8n', async (req, res) => {
    try {
        const { roomId, message, model } = req.body;
        
        const roomsData = await readJson(ROOMS_DATA_PATH, DEFAULT_ROOMS_DATA);
        const roomIndex = roomsData.rooms.findIndex(r => r.id === roomId);
        const room = roomsData.rooms[roomIndex];
        
        if(!room) return res.status(404).json({ok:false, error:"Salon introuvable"});

        // Sauvegarde message utilisateur
        const userMsg = { role: 'user', content: message, timestamp: new Date().toISOString() };
        room.messages = room.messages || [];
        room.messages.push(userMsg);
        await writeJson(ROOMS_DATA_PATH, roomsData);

        const config = await readJson(PERSONAS_CONFIG_PATH, DEFAULT_PERSONAS_DATA);
        const activeExperts = config.personas.filter(p => room.activePersonas.includes(p.id)).map(p => ({
            id: p.id, ministry_name: p.ministry, role_description: p.systemPrompt, emoji: p.avatarEmoji
        }));

        const payload = { question: message, room_id: roomId, orchestration_context: { available_experts: activeExperts } };
        
        // --- GESTION TÂCHE PERSISTANTE ---
        const taskId = crypto.randomUUID();
        // Sauvegarde initiale en mémoire ET disque
        await updateTask(taskId, { status: 'processing', roomId: roomId });

        (async () => {
            try {
                console.log(`[Chat] Envoi vers n8n (${N8N_CHAT_WEBHOOK})...`);
                const n8nRes = await fetch(N8N_CHAT_WEBHOOK, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) });
                const txt = await n8nRes.text();
                
                if(!n8nRes.ok) throw new Error(`Erreur n8n: ${txt}`);
                
                let json;
                try { json = JSON.parse(txt); } catch(e) { throw new Error("Réponse n8n invalide"); }
                
                // Normalisation
                let finalData = {};
                if (Array.isArray(json)) {
                    if (json.length > 0 && json[0].ministry_name) finalData = { responses: json };
                    else if (json.length > 0) finalData = json[0];
                    else finalData = { responses: [] };
                } else {
                    finalData = json;
                }
                
                console.log(`[Chat] Succès. Réponse reçue pour tâche ${taskId}`);

                // Sauvegarde de la réponse dans la salle
                const currentRoomsData = await readJson(ROOMS_DATA_PATH, DEFAULT_ROOMS_DATA);
                const currentRoom = currentRoomsData.rooms.find(r => r.id === roomId);
                if(currentRoom) {
                    currentRoom.messages = currentRoom.messages || [];
                    currentRoom.messages.push({ 
                        role: 'assistant', 
                        content: finalData, 
                        timestamp: new Date().toISOString() 
                    });
                    await writeJson(ROOMS_DATA_PATH, currentRoomsData);
                }

                // Mise à jour de la tâche : TERMINÉE
                await updateTask(taskId, { status: 'completed', data: finalData });

            } catch(e) { 
                console.error("[Chat Async Error]", e);
                // Mise à jour de la tâche : ERREUR
                await updateTask(taskId, { status: 'error', error: e.message });
            }
        })();

        res.json({ ok: true, taskId, status: 'processing' });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/chat/task/:taskId', async (req, res) => {
    // Lecture depuis la mémoire (rapide), peuplée au démarrage
    // Si pas en mémoire (cas très rare si initDataFiles a tourné), on pourrait lire le fichier
    let task = getTask(req.params.taskId);
    
    // Si pas en mémoire, tenter une relecture forcée du fichier pour être sûr (cas de concurrence inter-processus rare)
    if (!task) {
        const tasksData = await readJson(TASKS_DATA_PATH, DEFAULT_TASKS_DATA);
        task = tasksData.tasks.find(t => t.id === req.params.taskId);
    }
    
    if(!task) {
        return res.status(404).json({ok:false, status: 'not_found', error: 'Tâche inconnue ou expirée'});
    }
    
    res.json({
        ok: true, 
        status: task.status, 
        data: task.data, 
        error: task.error 
    });
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

// --- INIT ---
initDataFiles().then(() => {
    app.listen(PORT, () => console.log(`\n🚀 GouvBrain Backend ready on port ${PORT}`));
});

app.get('/admin', (req, res) => res.render('admin'));
app.get('/', (req, res) => res.render('gouvgpt'));