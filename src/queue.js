import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from './config.js';

export const redisConnection = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null,
});

export const QUEUE_NAME = 'pdf';

// Note: BullMQ forbids ':' in custom job ids — use '-' as separator.
export const chunkJobId = (exportId, index) => `chunk-${exportId}-${index}`;
export const mergeJobId = (exportId) => `merge-${exportId}`;

export const pdfQueue = new Queue(QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: config.maxRetries,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 1000 },
  },
});

export function enqueueChunk(exportId, chunkIndex) {
  return pdfQueue.add(
    'chunk',
    { exportId, chunkIndex },
    { jobId: chunkJobId(exportId, chunkIndex) }
  );
}

export function enqueueMerge(exportId) {
  return pdfQueue.add('merge', { exportId }, { jobId: mergeJobId(exportId) });
}
