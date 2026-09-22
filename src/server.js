import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import sharp from 'sharp';
import { config } from './config.js';
import { logger } from './logger.js';
import { migrate, query, waitForDb, pool } from './db.js';
import { ensureBucket } from './storage.js';
import { pdfQueue, redisConnection } from './queue.js';
import {
  createExport,
  getExport,
  listExports,
  getDownloadUrl,
  deleteExport,
} from './services/exportService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const app = Fastify({ logger: false });
const log = logger.child({ component: 'api' });

// Accept POSTs without a Content-Type/body (e.g. simple POST /exports).
app.addContentTypeParser('*', { parseAs: 'string' }, (req, body, done) => {
  if (!body) return done(null, {});
  try {
    done(null, JSON.parse(body));
  } catch {
    done(null, {});
  }
});

// ---------- Health ----------
app.get('/health', async () => ({ status: 'ok' }));

// ---------- Frontend (ultra light, static) ----------
app.get('/', async (req, reply) => {
  reply.type('text/html');
  return fs.readFile(path.join(publicDir, 'index.html'));
});

// ---------- Exports API ----------
app.post('/exports', async (req, reply) => {
  try {
    const exp = await createExport();
    return reply.code(202).send({ id: exp.id, status: exp.status });
  } catch (err) {
    return reply.code(err.statusCode || 500).send({ error: err.message });
  }
});

app.get('/exports', async () => listExports());

app.get('/exports/:id', async (req, reply) => {
  const exp = await getExport(req.params.id);
  if (!exp) return reply.code(404).send({ error: 'export not found' });
  return exp;
});

app.get('/exports/:id/download', async (req, reply) => {
  const result = await getDownloadUrl(req.params.id);
  if (result.error === 404) return reply.code(404).send({ error: 'export not found' });
  if (result.error === 409) return reply.code(409).send({ error: 'export not completed yet' });
  return reply.redirect(result.url);
});

app.delete('/exports/:id', async (req, reply) => {
  const deleted = await deleteExport(req.params.id);
  if (!deleted) return reply.code(404).send({ error: 'export not found' });
  return { deleted: true };
});

// ---------- Demo data: seed ----------
app.post('/admin/seed', async (req, reply) => {
  const count = Math.min(Math.max(parseInt(req.body?.count, 10) || 0, 1), 5_000_000);
  const batchSize = 1000;
  let inserted = 0;

  for (let offset = 0; offset < count; offset += batchSize) {
    const n = Math.min(batchSize, count - offset);
    const values = [];
    const params = [];
    for (let i = 0; i < n; i++) {
      const num = offset + i + 1;
      params.push(
        `Item #${num}`,
        `Description de l'élément ${num} — données de test pour génération PDF massif.`,
        `${config.demoImageBaseUrl}/demo/images/${num}`
      );
      values.push(`($${params.length - 2}, $${params.length - 1}, $${params.length})`);
    }
    await query(`INSERT INTO items (title, description, image_url) VALUES ${values.join(', ')}`, params);
    inserted += n;
  }
  log.info({ inserted }, 'seed completed');
  return { inserted };
});

app.delete('/admin/items', async () => {
  await query('TRUNCATE items');
  return { truncated: true };
});

// ---------- Demo data: deterministic generated images ----------
// Generates a realistic JPEG on the fly (no external network needed).
const imageCache = new Map();
app.get('/demo/images/:n', async (req, reply) => {
  const n = parseInt(req.params.n, 10) || 0;
  const key = n % 200; // bounded cache: 200 distinct images
  let buf = imageCache.get(key);
  if (!buf) {
    const hue = (n * 47) % 360;
    const svg = `<svg width="800" height="500" xmlns="http://www.w3.org/2000/svg">
      <rect width="800" height="500" fill="hsl(${hue}, 60%, 70%)"/>
      <circle cx="${100 + (n % 600)}" cy="${100 + (n % 300)}" r="80" fill="hsl(${(hue + 120) % 360}, 60%, 55%)"/>
      <text x="400" y="260" font-size="48" text-anchor="middle" fill="#222" font-family="sans-serif">Image ${n}</text>
    </svg>`;
    buf = await sharp(Buffer.from(svg)).jpeg({ quality: 75 }).toBuffer();
    imageCache.set(key, buf);
  }
  reply.header('Cache-Control', 'public, max-age=3600');
  return reply.type('image/jpeg').send(buf);
});

// ---------- Boot ----------
async function start() {
  await waitForDb();
  await migrate();
  await ensureBucket();

  await app.listen({ port: config.port, host: '0.0.0.0' });
  log.info({ port: config.port }, 'api listening');
}

async function shutdown() {
  await app.close();
  await pdfQueue.close();
  await redisConnection.quit();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch((err) => {
  log.error({ err: err.message }, 'api failed to start');
  process.exit(1);
});
