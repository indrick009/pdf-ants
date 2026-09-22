import fs from 'node:fs';
import PDFDocument from 'pdfkit';
import { config } from '../config.js';
import { prefetchImages } from './imageFetcher.js';

/**
 * Generate one chunk PDF (school report cards), streaming to disk.
 * One page = one student bulletin, fully laid out with absolute
 * coordinates (no page-flow overhead, no RAM buffering).
 *
 * Header (school banner) and paginated footer are drawn per page.
 * Page numbers are computed arithmetically: page X = student X,
 * total = count of students in the export. Zero extra cost.
 *
 * Returns { pages, imageErrors }.
 */

const W = 595.28; // A4 width (pt)
const H = 841.89; // A4 height (pt)
const M = 45; // page margin

function center(doc, text, y, { size = 9, bold = false, color = '#111111', opts = {} } = {}) {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica')
    .fontSize(size)
    .fillColor(color)
    .text(text, 0, y, { width: W, align: 'center', lineBreak: false, ...opts });
}

function mentionOf(note) {
  if (note >= 16) return 'Excellent';
  if (note >= 14) return 'Très Bien';
  if (note >= 12) return 'Bien';
  if (note >= 10) return 'Assez Bien';
  if (note >= 8) return 'Passable';
  return 'Insuffisant';
}

function appreciationOf(avg) {
  if (avg >= 16) return 'Excellent travail. Félicitations.';
  if (avg >= 14) return 'Très bon résultat, encourageable.';
  if (avg >= 12) return 'Bon travail, peut mieux faire.';
  if (avg >= 10) return 'Ensemble passable, des efforts restent nécessaires.';
  if (avg >= 8) return 'Résultats insuffisants, un travail sérieux s\'impose.';
  return 'Échec. Le travail de l\'année doit être repris.';
}

const fmt = (n) => n.toFixed(1).replace('.', ',');

function weightedAverage(subjects) {
  let sum = 0;
  let coefs = 0;
  for (const s of subjects) {
    sum += s.coef * s.note;
    coefs += s.coef;
  }
  return { avg: sum / coefs, coefs };
}

/** School banner header, drawn at the top of every page. */
function drawHeader(doc, studentNumber, totalPages, buf) {
  const navy = '#1d2b53';
  const gray = '#555555';

  center(doc, 'RÉPUBLIQUE DU CAMEROUN', 42, { size: 12, bold: true, color: navy });
  center(doc, 'Paix — Travail — Patrie', 55, { size: 8, color: gray });
  center(doc, 'MINISTÈRE DES ENSEIGNEMENTS SECONDAIRES', 66, { size: 9, bold: true, color: navy });
  center(doc, 'Complexe Scolaire Enko', 79, { size: 16, bold: true, color: '#0a2540' });
  center(doc, 'BULLETIN DE NOTES', 97, {
    size: 12,
    bold: true,
    color: navy,
    opts: { characterSpacing: 1 },
  });
  center(doc, 'Année scolaire 2025-2026 — Premier Trimestre', 111, { size: 8, color: gray });

  doc.moveTo(M, 120).lineTo(W - M, 120).lineWidth(1.2).strokeColor(navy).stroke();

  // Student photo (top right), with border and number label.
  const px = W - M - 64;
  const py = 32;
  doc.rect(px - 2, py - 2, 68, 90).lineWidth(1).strokeColor('#999999').stroke();
  if (buf) {
    doc.image(buf, px, py, { fit: [64, 82] });
  } else {
    doc.rect(px, py, 64, 82).fill('#eeeeee');
    doc.font('Helvetica').fontSize(7).fillColor('#999999')
      .text('Photo', px, py + 37, { width: 64, align: 'center', lineBreak: false });
  }
  doc.font('Helvetica').fontSize(7).fillColor('#333333')
    .text(`N° ${studentNumber}`, px, py + 86, { width: 64, align: 'center', lineBreak: false });
}

/** Paginated footer, drawn at the bottom of every page. */
function drawFooter(doc, studentNumber, totalPages) {
  const gray = '#777777';
  doc.moveTo(M, H - 52).lineTo(W - M, H - 52).lineWidth(0.6).strokeColor('#bbbbbb').stroke();
  doc.font('Helvetica').fontSize(7).fillColor(gray)
    .text('Complexe Scolaire Enko — B.P. 1234 Yaoundé — Tel : (237) 6 00 00 00 00', M, H - 44, {
      width: W - 2 * M,
      lineBreak: false,
    });
  doc.text(`Bulletin n° ${studentNumber} — Page ${studentNumber} / ${totalPages}`, M, H - 30, {
    width: W - 2 * M,
    align: 'center',
    lineBreak: false,
  });
}

/** Student identity block. */
function drawIdentity(doc, item) {
  const y0 = 128;
  const valColor = '#111111';
  const birth = item.birth_date ? new Date(item.birth_date).toLocaleDateString('fr-FR') : '—';

  doc.font('Helvetica').fontSize(9).fillColor(valColor)
    .text(`Nom : ${item.last_name}`, M, y0, { continued: true, lineBreak: false })
    .text(`    Prénom : ${item.first_name}`, { continued: true, lineBreak: false })
    .text(`    Sexe : ${item.gender}`, { lineBreak: false });

  doc.font('Helvetica').fontSize(9).fillColor(valColor)
    .text(`Né(e) le : ${birth}`, M, y0 + 16, { continued: true, lineBreak: false })
    .text(`    Matricule : ${item.matricule}`, { continued: true, lineBreak: false })
    .text(`    Classe : ${item.class_name}`, { lineBreak: false });

  doc.moveTo(M, y0 + 42).lineTo(W - M, y0 + 42).lineWidth(0.6).strokeColor('#cccccc').stroke();
}

/** Notes table: subject / coef / note / mention. */
function drawTable(doc, subjects) {
  const y0 = 182;
  const cols = [
    { x: M, w: 290 },
    { x: M + 295, w: 42 },
    { x: M + 342, w: 86 },
    { x: M + 432, w: W - M - 432 },
  ];

  // Header row
  const header = ['MATIÈRES', 'COEF', 'NOTE /20', 'MENTION'];
  doc.rect(M, y0, W - 2 * M, 18).fill('#1d2b53');
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff');
  doc.text(header[0], cols[0].x + 4, y0 + 5, { width: cols[0].w - 4, lineBreak: false });
  doc.text(header[1], cols[1].x, y0 + 5, { width: cols[1].w, align: 'center', lineBreak: false });
  doc.text(header[2], cols[2].x, y0 + 5, { width: cols[2].w, align: 'center', lineBreak: false });
  doc.text(header[3], cols[3].x + 4, y0 + 5, { width: cols[3].w - 4, lineBreak: false });

  let y = y0 + 18;
  subjects.forEach((s, i) => {
    if (i % 2 === 1) doc.rect(M, y, W - 2 * M, 17).fill('#f4f6fb');
    doc.font('Helvetica').fontSize(8.5).fillColor('#111111');
    doc.text(s.subject, cols[0].x + 4, y + 4, { width: cols[0].w - 4, lineBreak: false });
    doc.text(String(s.coef), cols[1].x, y + 4, { width: cols[1].w, align: 'center', lineBreak: false });
    doc.font('Helvetica-Bold')
      .text(fmt(s.note), cols[2].x, y + 4, { width: cols[2].w, align: 'center', lineBreak: false });
    doc.font('Helvetica').fillColor(mentionOf(s.note) === 'Excellent' ? '#0e7a2d' : '#111111')
      .text(mentionOf(s.note), cols[3].x + 4, y + 4, { width: cols[3].w - 4, lineBreak: false });
    y += 17;
  });
  doc.moveTo(M, y + 3).lineTo(W - M, y + 3).lineWidth(0.8).strokeColor('#1d2b53').stroke();
  return y + 12;
}

/** Summary block: average, mention, rank, decision, appreciation. */
function drawSummary(doc, item, totalPages, y0) {
  const { avg } = weightedAverage(item.subjects);
  const passed = avg >= 10;

  doc.font('Helvetica-Bold').fontSize(8).fillColor('#555555')
    .text('SYNTHÈSE', M, y0, { lineBreak: false });
  const yAvg = y0 + 8;

  doc.font('Helvetica-Bold').fontSize(14).fillColor('#1d2b53')
    .text('MOYENNE GÉNÉRALE : ', M, yAvg, { continued: true, lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(14).fillColor(passed ? '#0e7a2d' : '#b91c1c')
    .text(`${fmt(avg)} / 20`, { lineBreak: false });

  const yInfo = yAvg + 22;
  doc.font('Helvetica').fontSize(9).fillColor('#111111')
    .text(`Mention : ${mentionOf(avg)}`, M, yInfo, { continued: true, lineBreak: false })
    .text(`    Rang : ${item.student_number} / ${totalPages}`, { continued: true, lineBreak: false })
    .text(`    Effectif : ${totalPages}`, { lineBreak: false });

  const yDec = yInfo + 22;
  doc.rect(M, yDec, W - 2 * M, 20).fill(passed ? '#e9f7ee' : '#fdecec');
  doc.font('Helvetica-Bold').fontSize(9).fillColor(passed ? '#0e7a2d' : '#b91c1c')
    .text(`Décision du conseil : ${passed ? 'RÉUSSI' : 'ÉCHEC'}`, M + 8, yDec + 6, { lineBreak: false });

  doc.font('Helvetica-Oblique').fontSize(9).fillColor('#111111')
    .text(`Appréciation : ${appreciationOf(avg)}`, M, yDec + 28, { lineBreak: false });
}

/** Signature row. */
function drawSignatures(doc, y0) {
  const navy = '#1d2b53';
  const third = (W - 2 * M) / 3;
  for (const [i, label] of ['Le Proviseur', 'L\'Élève', 'Le Parent / Tuteur'].entries()) {
    const x = M + i * third;
    doc.moveTo(x + 10, y0).lineTo(x + third - 10, y0).lineWidth(0.6).strokeColor('#888888').stroke();
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(navy)
      .text(label, x, y0 + 6, { width: third, align: 'center', lineBreak: false });
  }
}

function drawBulletin(doc, item, totalPages, buf) {
  drawHeader(doc, item.student_number, totalPages, buf);
  drawIdentity(doc, item);
  const yAfterTable = drawTable(doc, item.subjects);
  drawSummary(doc, item, totalPages, yAfterTable);
  drawSignatures(doc, 600);
  drawFooter(doc, item.student_number, totalPages);
}

/**
 * Generate one chunk PDF, streaming to disk (never a giant in-memory DOM/HTML).
 * One page per student. Images are processed progressively with bounded
 * concurrency; failures render a placeholder instead of failing the chunk.
 *
 * Returns { pages, imageErrors }.
 */
export async function generateChunkPdf({ items, totalPages, destPath, log }) {
  // Text flow is disabled (everything is placed with absolute coordinates),
  // so margins are kept minimal to avoid PDFKit's implicit page breaks at
  // its default 72pt bottom margin (e.g. footer at the very bottom).
  const doc = new PDFDocument({
    size: 'A4',
    bufferPages: false,
    margins: { top: 10, bottom: 0, left: M, right: M },
  });
  const stream = fs.createWriteStream(destPath);
  doc.pipe(stream);

  let pages = 0;
  let imageErrors = 0;

  for await (const { item, buf } of prefetchImages(items, config.imageConcurrency, log)) {
    if (pages > 0) doc.addPage();
    drawBulletin(doc, item, totalPages, buf);
    if (!buf) imageErrors++;
    pages++;
  }

  doc.end();
  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  return { pages, imageErrors };
}