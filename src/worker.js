import fs from 'node:fs/promises';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { config } from './config.js';
import { logger } from './logger.js';
import { migrate, query, waitForDb, pool } from './db.js';
import { ensureBucket } from './storage.js';
import { QUEUE_NAME, pdfQueue, chunkJobId, mergeJobId, enqueueChunk, enqueueMerge } from './queue.js';
import { processChunk } from './services/chunkProcessor.js';
import { processMerge } from './services/mergeService.js';
import { startCleaner } from './services/cleaner.js';

const workerId = process.env.HOSTNAME || `worker-${process.pid}`;
const log = logger.child({ component: 'worker', worker_id: workerId });

/**
 * Crash/restart recovery: durable state lives in Postgres. On boot (and
 * periodically), re-enqueue jobs for chunks that are neither completed nor
 * failed but whose job disappeared (e.g. Redis restart without persistence).
 * Already-completed chunks are never re-enqueued.
 */
async function recoverStuckChunks() {
  const { rows } = await query(
    `SELECT c.export_id, c.chunk_index
     FROM export_chunks c
     JOIN exports e ON e.id = c.export_id
     WHERE e.status IN ('queued', 'processing')
       AND c.status IN ('queued', 'processing')`
  );
  let requeued = 0;
  for (const row of rows) {
    const job = await pdfQueue.getJob(chunkJobId(row.export_id, row.chunk_index));
    if (!job) {
      await enqueueChunk(row.export_id, row.chunk_index);
      requeued++;
    }
  }
  if (requeued > 0) log.info({ requeued }, 'recovery: stuck chunks re-enqueued');

  // Merge jobs that never got enqueued (e.g. crash right after last chunk).
  const { rows: stuckMerges } = await query(
    `SELECT id FROM exports
     WHERE status = 'processing'
       AND failed_chunks = 0
       AND completed_chunks = total_chunks`
  );
  for (const row of stuckMerges) {
    const job = await pdfQueue.getJob(mergeJobId(row.id));
    if (!job) {
      await enqueueMerge(row.id);
      log.info({ export_id: row.id }, 'recovery: stuck merge re-enqueued');
    }
  }
}

async function start() {
  await waitForDb();
  await migrate();
  await ensureBucket();
  await fs.mkdir(config.tmpDir, { recursive: true });

  // Remove temp leftovers from a previous crash.
  for (const entry of await fs.readdir(config.tmpDir)) {
    await fs.rm(`${config.tmpDir}/${entry}`, { recursive: true, force: true });
  }

  const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const jobLog = log.child({
        export_id: job.data.exportId,
        chunk_id: job.data.chunkIndex ?? job.name,
        job_name: job.name,
      });
      if (job.name === 'chunk') return processChunk(job, jobLog);
      if (job.name === 'merge') return processMerge(job, jobLog);
      throw new Error(`unknown job: ${job.name}`);
    },
    {
      connection,
      concurrency: config.workerConcurrency,
      stalledInterval: 30000,
      maxStalledCount: 2,
    }
  );

  worker.on('failed', (job, err) => {
    log.error({ job: job?.id, err: err.message }, 'job failed');
  });

  await recoverStuckChunks();
  const recoveryTimer = setInterval(
    () => recoverStuckChunks().catch((err) => log.error({ err: err.message }, 'recovery failed')),
    60000
  );
  recoveryTimer.unref();

  startCleaner(log);

  log.info(
    {
      concurrency: config.workerConcurrency,
      chunk_size: config.chunkSize,
      image_concurrency: config.imageConcurrency,
      max_retries: config.maxRetries,
    },
    'worker ready'
  );

  async function shutdown() {
    clearInterval(recoveryTimer);
    await worker.close();
    await pdfQueue.close();
    await connection.quit();
    await pool.end();
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((err) => {
  log.error({ err: err.message }, 'worker failed to start');
  process.exit(1);
});
