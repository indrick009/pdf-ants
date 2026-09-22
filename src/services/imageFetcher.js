import sharp from 'sharp';
import { config } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Download one image with timeout, size cap and limited retries,
 * then resize/compress it. Returns a JPEG buffer, or null on failure
 * (a failing image must never fail a whole chunk).
 */
export async function fetchImage(url, log) {
  let lastErr;
  for (let attempt = 0; attempt <= config.imageRetry; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.imageTimeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const length = Number(res.headers.get('content-length') || 0);
      if (length > config.imageMaxBytes) throw new Error(`image too large: ${length} bytes`);

      const chunks = [];
      let size = 0;
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > config.imageMaxBytes) throw new Error(`image too large: >${config.imageMaxBytes} bytes`);
        chunks.push(chunk);
      }

      return await sharp(Buffer.concat(chunks))
        .resize({ width: 800, withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toBuffer();
    } catch (err) {
      lastErr = err;
      if (attempt < config.imageRetry) await sleep(250 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  log.warn({ err: lastErr?.message, url }, 'image fetch failed, using placeholder');
  return null;
}

/**
 * Ordered prefetch pipeline: keeps up to `concurrency` downloads in flight
 * while the consumer iterates results in the original item order.
 * Memory stays bounded: at most `concurrency` image buffers at a time.
 */
export async function* prefetchImages(items, concurrency, log) {
  const executing = new Map();
  let next = 0;

  const launch = () => {
    while (executing.size < concurrency && next < items.length) {
      const idx = next++;
      const item = items[idx];
      executing.set(
        idx,
        fetchImage(item.photo_url, log).then((buf) => ({ item, buf }))
      );
    }
  };

  for (let i = 0; i < items.length; i++) {
    launch();
    const { item, buf } = await executing.get(i);
    executing.delete(i);
    launch();
    yield { item, buf };
  }
}
