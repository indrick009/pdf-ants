import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { query } from '../db.js';
import { downloadFile, finalKey, uploadFile, deletePrefix } from '../storage.js';

const execFileAsync = promisify(execFile);

/**
 * Merge all chunk PDFs into final.pdf using qpdf (streaming, low memory:
 * chunks are read from disk, never all loaded in RAM).
 * Idempotent: re-running overwrites the same final key.
 */
export async function processMerge(job, log) {
  const { exportId } = job.data;
  const startedAt = Date.now();

  const { rows: [exp] } = await query('SELECT * FROM exports WHERE id = $1', [exportId]);
  if (!exp) {
    log.warn('export not found, skipping merge');
    return;
  }
  if (exp.status === 'completed') {
    log.info('export already completed, skipping merge (idempotent)');
    return;
  }

  const { rows: chunks } = await query(
    `SELECT chunk_index, storage_key FROM export_chunks
     WHERE export_id = $1 AND status = 'completed'
     ORDER BY chunk_index`,
    [exportId]
  );
  if (chunks.length !== exp.total_chunks) {
    throw new Error(`cannot merge: ${chunks.length}/${exp.total_chunks} chunks completed`);
  }

  const dir = path.join(config.tmpDir, `merge-${exportId}`);
  await fs.mkdir(dir, { recursive: true });

  try {
    const files = [];
    for (const chunk of chunks) {
      const file = path.join(dir, `${String(chunk.chunk_index).padStart(6, '0')}.pdf`);
      await downloadFile(chunk.storage_key, file);
      files.push(file);
    }

    const finalPath = path.join(dir, 'final.pdf');
    await execFileAsync('qpdf', ['--empty', '--pages', ...files, '--', finalPath], {
      maxBuffer: 16 * 1024 * 1024,
    });

    const key = finalKey(exportId);
    await uploadFile(key, finalPath);

    await query(
      `UPDATE exports
       SET status = 'completed', progress = 100, completed_at = now()
       WHERE id = $1`,
      [exportId]
    );

    // Cleanup: chunk objects are no longer needed once final.pdf exists.
    const removed = await deletePrefix(`exports/${exportId}/chunks/`);
    log.info({ removed_chunk_objects: removed }, 'chunk objects cleaned');

    const mem = process.memoryUsage();
    log.info({
      chunks: chunks.length,
      duration_ms: Date.now() - startedAt,
      rss_mb: Math.round(mem.rss / 1024 / 1024),
    }, 'merge completed');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
