import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

export const query = (text, params) => pool.query(text, params);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function migrate() {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = await fs.readFile(path.join(dir, file), 'utf8');
    logger.info({ file }, 'running migration');
    await pool.query(sql);
  }
}

export async function waitForDb(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      logger.warn({ err: err.message, attempt: i + 1 }, 'waiting for database');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('database not reachable');
}
