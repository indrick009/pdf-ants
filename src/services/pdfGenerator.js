import fs from 'node:fs';
import PDFDocument from 'pdfkit';
import { config } from '../config.js';
import { prefetchImages } from './imageFetcher.js';

/**
 * Generate one chunk PDF, streaming to disk (never a giant in-memory DOM/HTML).
 * One page per item. Images are processed progressively with bounded
 * concurrency; failures render a placeholder instead of failing the chunk.
 *
 * Returns { pages, imageErrors }.
 */
export async function generateChunkPdf({ items, destPath, log }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: false });
  const stream = fs.createWriteStream(destPath);
  doc.pipe(stream);

  let pages = 0;
  let imageErrors = 0;

  for await (const { item, buf } of prefetchImages(items, config.imageConcurrency, log)) {
    if (pages > 0) doc.addPage();

    doc.fontSize(18).fillColor('#111111').text(item.title, { continued: false });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor('#555555').text(item.description);
    doc.moveDown(1);

    if (buf) {
      doc.image(buf, { fit: [495, 500], align: 'center' });
    } else {
      imageErrors++;
      const y = doc.y;
      doc.rect(50, y, 495, 200).fill('#eeeeee');
      doc.fillColor('#999999').fontSize(12)
        .text('Image indisponible', 50, y + 90, { width: 495, align: 'center' });
    }

    pages++;
  }

  doc.end();
  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  return { pages, imageErrors };
}
