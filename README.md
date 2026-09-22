# Enko — Génération PDF massif

Système fullstack de génération de PDF à très gros volume (10 000 → 300 000+ pages avec images), entièrement Dockerisé, non bloquant, scalable horizontalement et verticalement.

## Principe

```
POST /exports → job → partitionnement (chunks de N pages) → Redis queue
→ workers stateless en parallèle → chunk PDFs → merge (qpdf, streaming)
→ Object Storage (MinIO/S3) → URL de téléchargement
```

L'état durable est dans PostgreSQL ; Redis ne sert qu'à la distribution des jobs. Un chunk terminé n'est jamais regénéré (idempotence), un worker crashé est remplacé automatiquement (stalled recovery + re-enqueue au boot).

## Démarrage

```bash
docker compose up -d          # tout le stack : frontend+API, worker, redis, postgres, minio
docker compose up -d --scale worker=4   # scaling horizontal
docker compose down
```

- Frontend / API : http://localhost:3000
- Console MinIO : http://localhost:9001 (minioadmin / minioadmin)

## Test rapide

Dans l'UI : « Générer les données » (ex. 10 000) puis « Nouvel export PDF ».

Ou en CLI (depuis l'hôte, Node 20+) :

```bash
node scripts/bench.js 1000      # seed + export + mesure pages/s
node scripts/bench.js 300000
docker stats                    # observer CPU/RAM des workers pendant le bench
```

## API

| Méthode | Route | Description |
|---|---|---|
| POST | `/exports` | Crée l'export, partitionne, publie les jobs → `202 {id, status}` |
| GET | `/exports/:id` | Statut + progression |
| GET | `/exports/:id/download` | Redirige vers une URL pré-signée du PDF final |
| DELETE | `/exports/:id` | Supprime export (jobs, DB, objets) |
| POST | `/admin/seed` | `{count}` — génère des données de test |
| DELETE | `/admin/items` | Vide les données de test |

## Configuration (variables d'environnement)

| Variable | Défaut | Rôle |
|---|---|---|
| `PDF_CHUNK_SIZE` | 500 | Pages par chunk (partitionnement) |
| `PDF_WORKER_CONCURRENCY` | 1 | Chunks en parallèle par processus worker |
| `IMAGE_CONCURRENCY` | 4 | Téléchargements d'images simultanés par chunk |
| `IMAGE_TIMEOUT_MS` | 10000 | Timeout par image |
| `IMAGE_MAX_SIZE_MB` | 5 | Taille max d'une image |
| `IMAGE_RETRY` | 2 | Retries par image (placeholder si échec final) |
| `MAX_RETRIES` | 3 | Tentatives par chunk avant échec |
| `EXPORT_TTL_HOURS` | 24 | Rétention des exports terminés |
| `WORKER_CPU_LIMIT` / `WORKER_MEM_LIMIT` | 1.0 / 1G | Limites de ressources par worker (compose) |

## Scaling

- **Horizontal** : `docker compose up -d --scale worker=N`. Aucun changement de code. Les workers consomment la même queue Redis.
- **Vertical** : `PDF_WORKER_CONCURRENCY`, `IMAGE_CONCURRENCY`, limites compose. Commencer conservateur, mesurer avec `docker stats`, augmenter par paliers.
- **Multi-machine** : Redis/Postgres/S3 accessibles par réseau, lancer des conteneurs worker sur d'autres hôtes pointant vers les mêmes services.

## Reprise après crash

- Worker crash → BullMQ détecte le job stalled et le rejoue (idempotent).
- Redis restart → AOF activé ; de plus le worker ré-enfile au boot les chunks non terminés dont le job a disparu (la DB est la source de vérité).
- API/machine restart → les exports `queued`/`processing` reprennent automatiquement.

## Structure

```
src/
  server.js              API + frontend statique + images de démo
  worker.js              worker BullMQ + recovery + cleaner
  config.js              configuration par env
  db.js                  pool Postgres + migrations
  queue.js               queue BullMQ (jobIds déterministes)
  storage.js             client S3/MinIO
  services/
    exportService.js     création/partitionnement/lecture/suppression
    chunkProcessor.js    génération d'un chunk (idempotent)
    pdfGenerator.js      PDFKit streaming vers disque
    imageFetcher.js      download/validate/resize, prefetch borné
    mergeService.js      merge qpdf streaming + nettoyage chunks
    cleaner.js           purge des exports expirés
db/migrations/001_init.sql
public/index.html        frontend minimal
scripts/bench.js         test de charge
```
