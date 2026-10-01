import PDFDocument from 'pdfkit';
import type { Invoice } from '../../models/index.js';
import { formatMoney, toMajor } from '../../utils/money.js';

const INK = '#1c1c1e';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';
const ACCENT = '#111827';

/**
 * Render an invoice to a PDF buffer.
 *
 * The document is built from `invoice.snapshot`, which is frozen at issue time.
 * That is the whole reason the snapshot exists: a client who downloads the PDF
 * in a year sees the names, amounts and address that were true when it was sent,
 * even if the studio has since renamed itself or moved.
 *
 * Amounts are formatted from minor units, never from a float, so the PDF can
 * never disagree with the ledger by a rounding error.
 */
export function renderInvoicePdf(invoice: Invoice): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const currency = invoice.currency || 'NPR';
    const money = (minor: number) => formatMoney(minor, currency);

    drawHeader(doc, invoice);
    drawParties(doc, invoice, currency);
    drawMeta(doc, invoice, money);
    drawLines(doc, invoice);
    drawTotals(doc, invoice, money);

    if (invoice.notes) {
      doc.moveDown(1);
      doc.fontSize(9).fillColor(MUTED).text('Notes', { continued: false });
      doc.moveDown(0.3);
      doc.fontSize(9).fillColor(INK).text(invoice.notes);
    }

    drawFooter(doc, invoice);
    doc.end();
  });
}

function drawHeader(doc: PDFKit.PDFDocument, invoice: Invoice): void {
  const business = invoice.snapshot.photographerBusiness || invoice.snapshot.photographerName || 'Photographer';

  doc.fontSize(20).fillColor(ACCENT).text(business, { align: 'left' });
  doc.moveDown(0.2);
  doc.fontSize(9).fillColor(MUTED);

  const contact = [
    invoice.snapshot.photographerEmail,
    invoice.snapshot.photographerPhone,
    invoice.snapshot.photographerAddress,
  ]
    .filter(Boolean)
    .join('  \u00b7  ');
  if (contact) doc.text(contact);

  doc.moveDown(1.5);

  doc.fontSize(24).fillColor(INK).text('INVOICE', { align: 'right' });
  doc.fontSize(10).fillColor(MUTED).text(invoice.invoiceNumber, { align: 'right' });
  doc.moveDown(1.2);
}

function drawParties(doc: PDFKit.PDFDocument, invoice: Invoice, currency: string): void {
  const top = doc.y;
  const columnWidth = 240;

  doc.fontSize(8).fillColor(MUTED).text('BILLED TO', doc.x, top, { width: columnWidth, continued: false });
  let y = doc.y + 2;
  doc.fontSize(10).fillColor(INK);
  doc.text(invoice.snapshot.clientName || 'Client', doc.x, y, { width: columnWidth });
  y = doc.y;
  doc.fontSize(9).fillColor(MUTED);
  if (invoice.snapshot.clientEmail) {
    doc.text(invoice.snapshot.clientEmail, doc.x, y, { width: columnWidth });
    y = doc.y;
  }
  if (invoice.snapshot.clientPhone) {
    doc.text(invoice.snapshot.clientPhone, doc.x, y, { width: columnWidth });
  }

  const rightX = 320;
  doc.fontSize(8).fillColor(MUTED).text('AMOUNT DUE', rightX, top, { width: columnWidth, align: 'right' });
  doc.fontSize(14).fillColor(INK).text(formatMoney(invoice.remainingMinor, currency), rightX, top + 12, {
    width: columnWidth,
    align: 'right',
  });

  doc.y = Math.max(doc.y, top + 60);
  doc.moveDown(1);
}

function drawMeta(doc: PDFKit.PDFDocument, invoice: Invoice, money: (minor: number) => string): void {
  const rows: [string, string][] = [
    ['Invoice number', invoice.invoiceNumber],
    ['Issued', new Date(invoice.createdAt).toDateString()],
    ['Due date', invoice.dueDate ? new Date(invoice.dueDate).toDateString() : 'On receipt'],
    ['Status', invoice.status.replace('_', ' ')],
  ];
  if (invoice.snapshot.projectTitle) rows.splice(2, 0, ['Project', invoice.snapshot.projectTitle]);
  if (invoice.snapshot.eventDate) {
    rows.splice(rows.length, 0, ['Event date', new Date(invoice.snapshot.eventDate).toDateString()]);
  }
  if (invoice.snapshot.location) rows.push(['Location', invoice.snapshot.location]);
  if (invoice.depositDueMinor > 0) rows.push(['Deposit agreed', money(invoice.depositDueMinor)]);

  const startY = doc.y;
  for (const [label, value] of rows) {
    const y = doc.y;
    doc.fontSize(9).fillColor(MUTED).text(label, doc.x, y, { width: 110 });
    doc.fontSize(9).fillColor(INK).text(value, doc.x + 115, y, { width: 380 });
    doc.y = y + 16;
  }
  doc.y = startY + rows.length * 16 + 12;
}

function drawLines(doc: PDFKit.PDFDocument, invoice: Invoice): void {
  const columns = { description: 60, qty: 300, unit: 360, total: 430 };

  drawRule(doc, LINE);
  const headerY = doc.y + 6;
  doc.fontSize(8).fillColor(MUTED);
  doc.text('DESCRIPTION', doc.x, headerY, { width: 230 });
  doc.text('QTY', columns.qty, headerY, { width: 50, align: 'right' });
  doc.text('UNIT', columns.unit, headerY, { width: 60, align: 'right' });
  doc.text('AMOUNT', columns.total, headerY, { width: 70, align: 'right' });
  doc.y = headerY + 14;
  drawRule(doc, LINE);

  doc.fontSize(9).fillColor(INK);
  for (const line of invoice.lines) {
    const y = doc.y + 6;
    doc.text(line.description, doc.x, y, { width: 230 });
    doc.text(String(line.quantity), columns.qty, y, { width: 50, align: 'right' });
    doc.text(formatMoney(line.unitPriceMinor, invoice.currency), columns.unit, y, { width: 60, align: 'right' });
    doc.text(formatMoney(line.totalMinor, invoice.currency), columns.total, y, { width: 70, align: 'right' });
    doc.y = Math.max(doc.y, y + 14) + 2;
  }
  doc.moveDown(0.6);
}

function drawTotals(doc: PDFKit.PDFDocument, invoice: Invoice, money: (minor: number) => string): void {
  const rows: [string, number][] = [['Subtotal', invoice.subtotalMinor]];
  if (invoice.discountMinor > 0) rows.push(['Discount', -invoice.discountMinor]);
  if (invoice.taxMinor > 0) rows.push(['Tax', invoice.taxMinor]);

  for (const [label, minor] of rows) {
    const y = doc.y;
    doc.fontSize(9).fillColor(MUTED).text(label, 330, y, { width: 90, align: 'right' });
    doc.fontSize(9).fillColor(INK).text(money(Math.abs(minor)), 430, y, { width: 70, align: 'right' });
    doc.y = y + 15;
  }

  const totalY = doc.y + 2;
  drawRule(doc, LINE, totalY);
  doc.fontSize(11).fillColor(INK).text('Total', 330, totalY + 8, { width: 90, align: 'right' });
  doc.fontSize(11).text(money(invoice.totalMinor), 430, totalY + 8, { width: 70, align: 'right' });
  doc.y = totalY + 28;

  if (invoice.paidMinor > 0) {
    const y = doc.y;
    doc.fontSize(9).fillColor(MUTED).text('Paid', 330, y, { width: 90, align: 'right' });
    doc.fontSize(9).fillColor(INK).text(money(invoice.paidMinor), 430, y, { width: 70, align: 'right' });
    doc.y = y + 15;
  }

  const dueY = doc.y + 2;
  drawRule(doc, LINE, dueY);
  doc.fontSize(11).fillColor(ACCENT).text('Amount due', 330, dueY + 8, { width: 90, align: 'right' });
  doc.fontSize(11).text(money(invoice.remainingMinor), 430, dueY + 8, { width: 70, align: 'right' });
  doc.y = dueY + 30;
}

function drawFooter(doc: PDFKit.PDFDocument, invoice: Invoice): void {
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    const y = doc.page.height - 52;
    doc.fontSize(8).fillColor(MUTED);
    doc.text(
      `${invoice.invoiceNumber}  \u00b7  ${toMajor(invoice.remainingMinor).toFixed(2)} ${invoice.currency} due`,
      48,
      y,
      { width: 300, align: 'left' },
    );
    doc.text(`Page ${index + 1} of ${range.count}`, 380, y, { width: 130, align: 'right' });
  }
}

function drawRule(doc: PDFKit.PDFDocument, color: string, atY?: number): void {
  const y = atY ?? doc.y;
  doc
    .save()
    .moveTo(48, y)
    .lineTo(doc.page.width - 48, y)
    .lineWidth(0.5)
    .strokeColor(color)
    .stroke()
    .restore();
  if (atY === undefined) doc.y = y + 8;
}
