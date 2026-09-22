import { config } from '../config.js';
import { query } from '../db.js';
import { enqueueChunk, chunkJobId, mergeJobId, pdfQueue } from '../queue.js';
import { deletePrefix, finalKey, presignedDownload } from '../storage.js';

/**
 * Create an export: count items, partition into independent chunks,
 * persist chunk rows (durable state), publish jobs to Redis, return at once.
 */
export async function createExport() {
  const { rows: [{ count }] } = await query('SELECT COUNT(*)::int AS count FROM items');
  const total = count;
  if (total === 0) {
    const err = new Error('no items to export (seed data first)');
    err.statusCode = 400;
    throw err;
  }

  const totalChunks = Math.ceil(total / config.chunkSize);

  const { rows: [exp] } = await query(
    `INSERT INTO exports (status, total_items, total_chunks)
     VALUES ('queued', $1, $2)
     RETURNING id, status, total_items, total_chunks, created_at`,
    [total, totalChunks]
  );

  const values = [];
  const params = [];
  for (let i = 0; i < totalChunks; i++) {
    const start = i * config.chunkSize;
    const end = Math.min(start + config.chunkSize, total);
    params.push(exp.id, i, start, end);
    values.push(`($${params.length - 3}, $${params.length - 2}, $${params.length - 1}, $${params.length})`);
  }
  await query(
    `INSERT INTO export_chunks (export_id, chunk_index, start_offset, end_offset)
     VALUES ${values.join(', ')}
     ON CONFLICT (export_id, chunk_index) DO NOTHING`,
    params
  );

  for (let i = 0; i < totalChunks; i++) {
    await enqueueChunk(exp.id, i);
  }

  return exp;
}

export async function getExport(id) {
  const { rows: [exp] } = await query('SELECT * FROM exports WHERE id = $1', [id]);
  if (!exp) return null;

  const body = {
    id: exp.id,
    status: exp.status,
    total: exp.total_items,
    processed: exp.processed_items,
    progress: Number(exp.progress),
    total_chunks: exp.total_chunks,
    completed_chunks: exp.completed_chunks,
    failed_chunks: exp.failed_chunks,
    created_at: exp.created_at,
    completed_at: exp.completed_at,
    error: exp.error,
  };
  if (exp.status === 'completed') {
    body.download_url = `/exports/${exp.id}/download`;
  }
  return body;
}

export async function listExports(limit = 50) {
  const { rows } = await query(
    `SELECT id, status, total_items, processed_items, progress, total_chunks,
            completed_chunks, failed_chunks, created_at, completed_at, error
     FROM exports ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return rows.map((exp) => ({
    id: exp.id,
    status: exp.status,
    total: exp.total_items,
    processed: exp.processed_items,
    progress: Number(exp.progress),
    total_chunks: exp.total_chunks,
    completed_chunks: exp.completed_chunks,
    failed_chunks: exp.failed_chunks,
    created_at: exp.created_at,
    completed_at: exp.completed_at,
    error: exp.error,
    ...(exp.status === 'completed' ? { download_url: `/exports/${exp.id}/download` } : {}),
  }));
}

export async function getDownloadUrl(id) {
  const { rows: [exp] } = await query('SELECT status FROM exports WHERE id = $1', [id]);
  if (!exp) return { error: 404 };
  if (exp.status !== 'completed') return { error: 409 };
  return { url: await presignedDownload(finalKey(id)) };
}

export async function deleteExport(id) {
  const { rows: [exp] } = await query('SELECT id FROM exports WHERE id = $1', [id]);
  if (!exp) return false;

  // Best effort: remove pending jobs so workers stop picking up chunks.
  const { rows: chunks } = await query(
    'SELECT chunk_index FROM export_chunks WHERE export_id = $1',
    [id]
  );

  for (const c of chunks) {
    const job = await pdfQueue.getJob(chunkJobId(id, c.chunk_index));
    if (job) await job.remove().catch(() => {});
  }
  const mergeJob = await pdfQueue.getJob(mergeJobId(id));
  if (mergeJob) await mergeJob.remove().catch(() => {});

  await query('DELETE FROM exports WHERE id = $1', [id]);
  await deletePrefix(`exports/${id}/`);
  return true;
}
