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
// Deterministic school dataset: 10 surnames x 10 first names enumerated,
// moderate score variation (low jitter around a mark that grows with rank).
const SURNAMES = [
  'FOTSO', 'NDONGO', 'KAMDEM', 'MOMO', 'MBALLA',
  'ETOUNDI', 'TCHATCHOUANG', 'NDI', 'FOKOU', 'TCHUENTE',
];
const FIRST_NAMES = [
  'Jean', 'Marie', 'Paul', 'Aïcha', 'Emmanuel',
  'Clarisse', 'Samuel', 'Nadine', 'Eric', 'Sandrine',
];
const GENDERS = ['M', 'F', 'M', 'F', 'M', 'F', 'M', 'F', 'M', 'F'];
const CLASSES = ['6ème A', '5ème B', '4ème A', '3ème B', '2nde C', '1ère D', 'Terminale A4'];
const SUBJECTS = [
  { subject: 'Français', coef: 4 },
  { subject: 'Mathématiques', coef: 4 },
  { subject: 'Anglais', coef: 2 },
  { subject: 'Histoire-Géographie', coef: 2 },
  { subject: 'Sciences de la Vie et de la Terre', coef: 2 },
  { subject: 'Physique-Chimie', coef: 2 },
  { subject: 'Informatique', coef: 1 },
  { subject: 'Éducation Physique et Sportive', coef: 1 },
];

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Mark /20 for a student, grows with the student number so that
// rank displayed on the bulletin stays coherent. Moderate jitter.
function buildSubjects(num, total) {
  const base = 5 + 13 * (num / total);
  const subjects = SUBJECTS.map((s, i) => {
    const rnd = mulberry32(num * 31 + i * 17 + 7);
    const note = Math.min(20, Math.max(2, (base + (rnd() - 0.5) * 7) * 10)) / 10;
    return { subject: s.subject, coef: s.coef, note: Math.round(note * 10) / 10 };
  });
  return subjects;
}

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
      const lastName = SURNAMES[(num - 1) % SURNAMES.length];
      const firstName = FIRST_NAMES[Math.floor((num - 1) / SURNAMES.length) % FIRST_NAMES.length];
      const gender = GENDERS[Math.floor((num - 1) / SURNAMES.length) % GENDERS.length];
      const className = CLASSES[(num - 1) % CLASSES.length];
      const birth = new Date(Date.UTC(2006 + ((num - 1) % 6), (num - 1) % 12, ((num - 1) % 28) + 1));
      const birthDate = birth.toISOString().slice(0, 10);
      const matricule = `ENK-${String(num).padStart(6, '0')}`;
      const subjects = buildSubjects(num, count);
      const photoUrl = `${config.demoImageBaseUrl}/demo/images/${num}`;
      params.push(
        lastName,
        firstName,
        gender,
        className,
        birthDate,
        matricule,
        num,
        photoUrl,
        JSON.stringify(subjects)
      );
      values.push(
        `($${params.length - 8}, $${params.length - 7}, $${params.length - 6}, ` +
        `$${params.length - 5}, $${params.length - 4}::date, $${params.length - 3}, ` +
        `$${params.length - 2}, $${params.length - 1}, $${params.length}::jsonb)`
      );
    }
    await query(
      `INSERT INTO items (last_name, first_name, gender, class_name, birth_date, matricule, student_number, photo_url, subjects)
       VALUES ${values.join(', ')}`,
      params
    );
    inserted += n;
  }
  log.info({ inserted }, 'seed completed');
  return { inserted };
});

app.delete('/admin/items', async () => {
  await query('TRUNCATE items');
  return { truncated: true };
});

// ---------- Demo data: deterministic generated photos ----------
// Generates a realistic placeholder on the fly (no external network needed).
// One photo per student, bounded cache of 200 distinct images.
const imageCache = new Map();
app.get('/demo/images/:n', async (req, reply) => {
  const n = parseInt(req.params.n, 10) || 0;
  const key = n % 200; // bounded cache: 200 distinct images
  let buf = imageCache.get(key);
  if (!buf) {
    const hue = (n * 47) % 360;
    // Passport-size placeholder: keeps worker-side image processing cheap
    // (the bulletin photo zone is ~64x82pt, ~350x450px is more than enough).
    const svg = `<svg width="350" height="450" xmlns="http://www.w3.org/2000/svg">
      <rect width="350" height="450" fill="#eef2f7"/>
      <rect x="26" y="26" width="298" height="398" fill="#fff" stroke="#c3cad6" stroke-width="4"/>
      <circle cx="175" cy="165" r="72" fill="hsl(${hue}, 55%, 70%)"/>
      <path d="M52 424 Q78 295 175 295 Q272 295 298 424 Z" fill="hsl(${(hue + 120) % 360}, 45%, 55%)"/>
      <text x="175" y="414" font-size="24" text-anchor="middle" fill="#333" font-family="sans-serif">N° ${n}</text>
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
