# AGENTS.md

## Projet

Système de génération PDF massif (10k–300k+ pages) : API Fastify, workers BullMQ stateless, Redis (queue), PostgreSQL (état durable), MinIO (S3). Tout tourne via `docker compose up -d`.

## Commandes

- Démarrer : `docker compose up -d`
- Scaler : `docker compose up -d --scale worker=N`
- Logs : `docker compose logs -f worker`
- Bench : `node scripts/bench.js <nb_items>` (depuis l'hôte, Node 20+)
- Arrêter : `docker compose down`

## Règles d'architecture (à ne pas casser)

1. L'API ne génère jamais de PDF ; elle partitionne et publie dans Redis.
2. Workers stateless : aucun état critique hors PostgreSQL ; fichiers temporaires uniquement dans `TMP_DIR`, supprimés après usage.
3. Chunks indépendants et idempotents : jobId déterministe `chunk-{exportId}-{index}` (`:` interdit par BullMQ), clé S3 fixe, skip si `status='completed'`.
4. Jamais de chargement massif en RAM : PDFKit streamé vers disque, images pré-fetchées avec concurrence bornée, merge via binaire `qpdf` (disque, pas RAM).
5. Progression mise à jour par chunk (compteurs atomiques SQL), jamais par page.
6. Une image en échec → placeholder, jamais d'échec de chunk.
7. Nouvelles dépendances npm : justifier ; rester minimal.

## Conventions

- Node 20, ESM (`"type": "module"`), JS plain (pas de TS).
- Logs structurés pino : toujours inclure `export_id`, `chunk_id`, `duration_ms` quand pertinent.
- Migrations SQL idempotentes dans `db/migrations/`, exécutées au boot.
- Variables d'environnement : valeurs par défaut dans `src/config.js` ET `docker-compose.yml` (section `x-app-env`).
