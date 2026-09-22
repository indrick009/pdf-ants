import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { query, pool } from '../db.js';
import { chunkKey, uploadFile } from '../storage.js';
import { enqueueMerge } from '../queue.js';
import { generateChunkPdf } from './pdfGenerator.js';

/**
 * Process one chunk job. Idempotent: a chunk already marked completed is
 * skipped, and re-running a chunk overwrites the same storage key.
 */
export async function processChunk(job, log) {
  const { exportId, chunkIndex } = job.data;
  const startedAt = Date.now();

  const { rows: [chunk] } = await query(
    'SELECT * FROM export_chunks WHERE export_id = $1 AND chunk_index = $2',
    [exportId, chunkIndex]
  );
  if (!chunk) {
    log.warn('chunk row not found (export deleted?), skipping');
    return;
  }
  if (chunk.status === 'completed') {
    log.info('chunk already completed, skipping (idempotent)');
    return;
  }

  await query(
    `UPDATE export_chunks
     SET status = 'processing', attempts = attempts + 1, error = NULL
     WHERE id = $1`,
    [chunk.id]
  );
  await query(`UPDATE exports SET status = 'processing' WHERE id = $1 AND status = 'queued'`, [exportId]);

  const tmpFile = path.join(config.tmpDir, `${exportId}-${chunkIndex}.pdf`);
  await fs.mkdir(config.tmpDir, { recursive: true });

  try {
    const { rows: items } = await query(
      `SELECT last_name, first_name, gender, class_name, birth_date, matricule,
              student_number, photo_url, subjects
       FROM items ORDER BY id LIMIT $1 OFFSET $2`,
      [chunk.end_offset - chunk.start_offset, chunk.start_offset]
    );

    // Total pages across the whole export — used for "Page X / Y" in the
    // footer. Since one report card = one page, this is known in advance.
    const { rows: [expRow] } = await query(
      'SELECT total_items FROM exports WHERE id = $1',
      [exportId]
    );
    const totalPages = expRow?.total_items ?? items.length;

    const { pages, imageErrors } = await generateChunkPdf({
      items,
      totalPages,
      destPath: tmpFile,
      log,
    });

    const key = chunkKey(exportId, chunkIndex);
    await uploadFile(key, tmpFile);

    // Chunk completion + export counters in ONE transaction: exactly-once
    // semantics even if the job is retried afterwards.
    const client = await pool.connect();
    let exp;
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE export_chunks
         SET status = 'completed', storage_key = $1, image_errors = $2, completed_at = now()
         WHERE id = $3`,
        [key, imageErrors, chunk.id]
      );
      const { rows: [row] } = await client.query(
        `UPDATE exports
         SET completed_chunks = completed_chunks + 1,
             processed_items = processed_items + $2,
             progress = ROUND(100.0 * (processed_items + $2) / total_items, 1)
         WHERE id = $1
         RETURNING completed_chunks, failed_chunks, total_chunks`,
        [exportId, pages]
      );
      exp = row;
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    const mem = process.memoryUsage();
    log.info({
      pages,
      image_errors: imageErrors,
      duration_ms: Date.now() - startedAt,
      attempts: job.attemptsMade + 1,
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      heap_mb: Math.round(mem.heapUsed / 1024 / 1024),
      export_progress: exp ? `${exp.completed_chunks}/${exp.total_chunks}` : 'n/a',
    }, 'chunk completed');

    if (exp && exp.completed_chunks + exp.failed_chunks === exp.total_chunks) {
      if (exp.failed_chunks > 0) {
        await query(
          `UPDATE exports SET status = 'failed', error = $2, completed_at = now() WHERE id = $1`,
          [exportId, `${exp.failed_chunks} chunk(s) failed after retries`]
        );
        log.error({ failed_chunks: exp.failed_chunks }, 'export failed: chunks missing');
      } else {
        // Non-fatal: the worker recovery sweep re-enqueues a missing merge.
        await enqueueMerge(exportId).catch((err) =>
          log.error({ err: err.message }, 'failed to enqueue merge (recovery will retry)')
        );
        log.info('all chunks completed, merge enqueued');
      }
    }
  } catch (err) {
    const lastAttempt = job.attemptsMade + 1 >= job.opts.attempts;
    await query(
      `UPDATE export_chunks SET status = $1, error = $2 WHERE id = $3`,
      [lastAttempt ? 'failed' : 'queued', err.message, chunk.id]
    );
    if (lastAttempt) {
      const { rows: [exp] } = await query(
        `UPDATE exports
         SET failed_chunks = failed_chunks + 1
         WHERE id = $1
         RETURNING completed_chunks, failed_chunks, total_chunks`,
        [exportId]
      );
      if (exp && exp.completed_chunks + exp.failed_chunks === exp.total_chunks) {
        await query(
          `UPDATE exports SET status = 'failed', error = $2, completed_at = now() WHERE id = $1`,
          [exportId, `${exp.failed_chunks} chunk(s) failed after retries`]
        );
      }
    }
    log.error({ err: err.message, attempts: job.attemptsMade + 1, duration_ms: Date.now() - startedAt }, 'chunk failed');
    throw err; // let BullMQ handle retry / stalled recovery
  } finally {
    await fs.rm(tmpFile, { force: true });
  }
}
