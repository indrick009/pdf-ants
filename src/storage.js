import { Client } from 'minio';
import { config } from './config.js';
import { logger } from './logger.js';

export const s3 = new Client({
  endPoint: config.s3.endPoint,
  port: config.s3.port,
  useSSL: config.s3.useSSL,
  accessKey: config.s3.accessKey,
  secretKey: config.s3.secretKey,
  region: 'us-east-1', // avoids a network round-trip for region lookup
});

const bucket = config.s3.bucket;

// Separate client used only to presign URLs reachable from outside the
// docker network (browser / host).
const publicS3 = new Client({
  endPoint: config.s3.publicEndPoint,
  port: config.s3.publicPort,
  useSSL: config.s3.publicUseSSL,
  accessKey: config.s3.accessKey,
  secretKey: config.s3.secretKey,
  region: 'us-east-1',
});

export async function ensureBucket(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const exists = await s3.bucketExists(bucket);
      if (!exists) await s3.makeBucket(bucket);
      return;
    } catch (err) {
      logger.warn({ err: err.message, attempt: i + 1 }, 'waiting for object storage');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('object storage not reachable');
}

export const chunkKey = (exportId, index) =>
  `exports/${exportId}/chunks/${String(index).padStart(6, '0')}.pdf`;

export const finalKey = (exportId) => `exports/${exportId}/final.pdf`;

export function uploadFile(key, filePath) {
  return s3.fPutObject(bucket, key, filePath, { 'Content-Type': 'application/pdf' });
}

export function downloadFile(key, filePath) {
  return s3.fGetObject(bucket, key, filePath);
}

export function presignedDownload(key, expirySeconds = 3600) {
  return publicS3.presignedGetObject(bucket, key, expirySeconds);
}

export async function deletePrefix(prefix) {
  const keys = [];
  const stream = s3.listObjectsV2(bucket, prefix, true);
  for await (const obj of stream) keys.push(obj.name);
  if (keys.length > 0) await s3.removeObjects(bucket, keys);
  return keys.length;
}
