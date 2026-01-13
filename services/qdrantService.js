const { QdrantClient } = require('@qdrant/js-client-rest');
const OpenAI = require('openai');
const { RecursiveCharacterTextSplitter } = require('langchain/text_splitter');
const crypto = require('crypto');

// Configuration
const VECTOR_SIZE = 1536; // Standard OpenAI (text-embedding-3-small)
const COLLECTION_NAME = 'gouvbrain_knowledge';

class QdrantService {
    constructor() {
        // Initialisation du client Qdrant
        this.client = new QdrantClient({
            url: process.env.QDRANT_URL || 'http://localhost:6333',
            apiKey: process.env.QDRANT_API_KEY, // Si nécessaire
        });

        // Initialisation OpenAI pour les embeddings
        this.openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });

        // Auto-init au démarrage
        this.initCollection();
    }

    /**
     * Initialise la collection si elle n'existe pas
     * Configure la distance Cosine et les index de filtrage
     */
    async initCollection() {
        try {
            const result = await this.client.getCollections();
            const exists = result.collections.find(c => c.name === COLLECTION_NAME);

            if (!exists) {
                console.log(`[Qdrant] Création de la collection ${COLLECTION_NAME}...`);
                await this.client.createCollection(COLLECTION_NAME, {
                    vectors: {
                        size: VECTOR_SIZE,
                        distance: 'Cosine',
                    },
                });

                // Création d'index pour optimiser les filtres (CRUCIAL pour la perf)
                await this.client.createPayloadIndex(COLLECTION_NAME, {
                    field_name: 'persona_id',
                    field_schema: 'keyword',
                });
                await this.client.createPayloadIndex(COLLECTION_NAME, {
                    field_name: 'source_file',
                    field_schema: 'keyword',
                });
                console.log('[Qdrant] Collection initialisée avec succès.');
            }
        } catch (error) {
            console.error('[Qdrant] Erreur init:', error.message);
        }
    }

    /**
     * Génère les vecteurs (embeddings) pour une liste de textes
     */
    async getEmbeddings(texts) {
        // Nettoyage basique
        const cleanTexts = texts.map(t => t.replace(/\n/g, ' '));
        
        const response = await this.openai.embeddings.create({
            model: "text-embedding-3-small",
            input: cleanTexts,
            encoding_format: "float",
        });

        return response.data.map(item => item.embedding);
    }

    /**
     * Ingestion intelligente de connaissance
     * @param {string} personaId - ID du ministre
     * @param {string} content - Contenu textuel complet
     * @param {object} metadata - Métadonnées (filename, type, etc.)
     */
    async ingestKnowledge(personaId, content, metadata = {}) {
        console.log(`[Qdrant] Début ingestion pour ${personaId} (${metadata.filename})`);

        // 1. Chunking Intelligent (LangChain)
        // Overlap de 200 chars pour garder le contexte entre les segments
        const splitter = new RecursiveCharacterTextSplitter({
            chunkSize: 1000,
            chunkOverlap: 200, 
        });

        const docs = await splitter.createDocuments([content]);
        const chunks = docs.map(d => d.pageContent);

        if (chunks.length === 0) return { count: 0 };

        // 2. Vectorisation (Batch)
        // Note: En prod, faire des batches de 100 max pour l'API OpenAI
        const vectors = await this.getEmbeddings(chunks);

        // 3. Construction des points (Payload riche)
        const points = chunks.map((chunk, index) => {
            return {
                id: crypto.randomUUID(),
                vector: vectors[index],
                payload: {
                    content: chunk,
                    persona_id: personaId,
                    source_file: metadata.filename || 'unknown',
                    chunk_index: index,
                    ingestion_date: new Date().toISOString(),
                    type: metadata.type || 'text',
                    ...metadata // Fusionne les métadonnées spécifiques (ex: page number)
                }
            };
        });

        // 4. Upsert dans Qdrant
        await this.client.upsert(COLLECTION_NAME, {
            wait: true,
            points: points,
        });

        console.log(`[Qdrant] ${points.length} vecteurs indexés.`);
        return { count: points.length };
    }

    /**
     * Recherche Sémantique (RAG Core)
     */
    async search(query, personaId = null, limit = 5) {
        const queryVector = (await this.getEmbeddings([query]))[0];

        // Filtre strict sur le persona si fourni
        const filter = personaId ? {
            must: [
                { key: 'persona_id', match: { value: personaId } }
            ]
        } : undefined;

        const results = await this.client.search(COLLECTION_NAME, {
            vector: queryVector,
            filter: filter,
            limit: limit,
            with_payload: true,
        });

        return results.map(hit => ({
            text: hit.payload.content,
            score: hit.score,
            metadata: {
                source: hit.payload.source_file,
                page: hit.payload.page_number
            }
        }));
    }

    /**
     * Suppression Atomique de Documents
     * Permet la mise à jour (supprimer avant de réinsérer)
     */
    async deleteKnowledge(personaId, filename = null) {
        const filters = [
            { key: 'persona_id', match: { value: personaId } }
        ];

        if (filename) {
            filters.push({ key: 'source_file', match: { value: filename } });
        }

        await this.client.delete(COLLECTION_NAME, {
            filter: {
                must: filters
            }
        });
        console.log(`[Qdrant] Nettoyage effectué pour ${personaId} (Cible: ${filename || 'TOUT'})`);
    }
}

module.exports = new QdrantService();