const fs = require('fs');
const pdf = require('pdf-parse'); // npm install pdf-parse
const qdrantService = require('../services/qdrantService');

const KnowledgeController = {

    // --- Ingestion de Texte Brut (Notes manuelles) ---
    ingestText: async (req, res) => {
        try {
            const { personaId } = req.params;
            const { title, content } = req.body;

            if (!content || !title) {
                return res.status(400).json({ ok: false, error: "Titre et contenu requis" });
            }

            // 1. Nettoyage préventif (Update strategy)
            await qdrantService.deleteKnowledge(personaId, title);

            // 2. Ingestion
            const result = await qdrantService.ingestKnowledge(personaId, content, {
                filename: title,
                type: 'manual_note',
                page_number: 1
            });

            res.json({ ok: true, stats: result });
        } catch (error) {
            console.error(error);
            res.status(500).json({ ok: false, error: error.message });
        }
    },

    // --- Ingestion de Fichiers (PDF/TXT) ---
    ingestFile: async (req, res) => {
        try {
            const { personaId } = req.params;
            const file = req.file;

            if (!file) return res.status(400).json({ ok: false, error: "Fichier manquant" });

            let textContent = "";
            let meta = { page_count: 1 };

            // Extraction du contenu
            if (file.mimetype === 'application/pdf') {
                const dataBuffer = fs.readFileSync(file.path);
                
                // Extraction avec pdf-parse
                // Pour une traçabilité page par page parfaite, on utiliserait un parser plus complexe
                // Ici, on simule ou on utilise les métadonnées globales
                const pdfData = await pdf(dataBuffer);
                textContent = pdfData.text;
                meta.page_count = pdfData.numpages;
                meta.info = pdfData.info;

            } else if (file.mimetype === 'text/plain') {
                textContent = fs.readFileSync(file.path, 'utf8');
            } else {
                return res.status(400).json({ ok: false, error: "Format non supporté (PDF/TXT uniquement)" });
            }

            // 1. Suppression de l'ancienne version
            await qdrantService.deleteKnowledge(personaId, file.originalname);

            // 2. Ingestion
            const result = await qdrantService.ingestKnowledge(personaId, textContent, {
                filename: file.originalname,
                type: 'file_upload',
                ...meta
            });

            // 3. Cleanup fichier temporaire
            try { fs.unlinkSync(file.path); } catch(e) {}

            res.json({ ok: true, stats: result });

        } catch (error) {
            console.error(error);
            res.status(500).json({ ok: false, error: error.message });
        }
    },

    // --- Suppression d'un document spécifique ---
    deleteDocument: async (req, res) => {
        try {
            const { personaId, filename } = req.params;
            await qdrantService.deleteKnowledge(personaId, filename);
            res.json({ ok: true, message: "Document supprimé de la mémoire vectorielle." });
        } catch (error) {
            res.status(500).json({ ok: false, error: error.message });
        }
    },
    
    // --- Test de recherche (Debug) ---
    searchDebug: async (req, res) => {
        try {
            const { personaId } = req.params;
            const { q } = req.query;
            const results = await qdrantService.search(q, personaId);
            res.json({ ok: true, results });
        } catch (error) {
            res.status(500).json({ ok: false, error: error.message });
        }
    }
};

module.exports = KnowledgeController;