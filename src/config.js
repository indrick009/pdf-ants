const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

export const config = {
  port: int(process.env.PORT, 3000),
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/enko',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  s3: {
    endPoint: process.env.S3_ENDPOINT || 'localhost',
    port: int(process.env.S3_PORT, 9000),
    useSSL: process.env.S3_USE_SSL === 'true',
    accessKey: process.env.S3_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.S3_SECRET_KEY || 'minioadmin',
    bucket: process.env.S3_BUCKET || 'exports',
    // Public endpoint used ONLY for presigned download URLs (browser-facing).
    publicEndPoint: process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT || 'localhost',
    publicPort: int(process.env.S3_PUBLIC_PORT, int(process.env.S3_PORT, 9000)),
    publicUseSSL: process.env.S3_PUBLIC_USE_SSL
      ? process.env.S3_PUBLIC_USE_SSL === 'true'
      : process.env.S3_USE_SSL === 'true',
  },

  // Partitioning
  chunkSize: int(process.env.PDF_CHUNK_SIZE, 500),

  // Vertical scaling knobs (per worker process)
  workerConcurrency: int(process.env.PDF_WORKER_CONCURRENCY, 1),
  batchSize: int(process.env.PDF_BATCH_SIZE, 500),

  // Images
  imageConcurrency: int(process.env.IMAGE_CONCURRENCY, 4),
  imageTimeoutMs: int(process.env.IMAGE_TIMEOUT_MS, 10000),
  imageMaxBytes: int(process.env.IMAGE_MAX_SIZE_MB, 5) * 1024 * 1024,
  imageRetry: int(process.env.IMAGE_RETRY, 2),

  // Retries / jobs
  maxRetries: int(process.env.MAX_RETRIES, 3),

  // Retention
  exportTtlHours: int(process.env.EXPORT_TTL_HOURS, 24),

  demoImageBaseUrl: process.env.DEMO_IMAGE_BASE_URL || 'http://localhost:3000',
  tmpDir: process.env.TMP_DIR || '/tmp/pdf-export',
};
