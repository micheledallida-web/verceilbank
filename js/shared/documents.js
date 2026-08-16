// Statements are the one artefact that leaves the app and gets filed, so the
// footer stamped on them has to be as true as anything shown on screen.
import { documentFooterLine } from './deposit-insurance.js';

// ==================== DOWNLOADING A DOCUMENT ====================
// One place for what "Download PDF" means, because three screens offer it —
// Investment Statements, the Account Documents hub and Tax Documents — and
// none of them was doing it.
//
// What they did was open a second window with an HTML summary in it and leave
// the customer to find Print > Save as PDF. On a phone that is not a download
// at all: mobile Safari blocks a window opened after an `await`, and when it
// does open one the customer is looking at a web page they asked to have as a
// file. The button said Download PDF and produced neither a download nor a PDF.
//
// So there are two paths here, in this order:
//
//   1. THE REAL DOCUMENT. If the bank has generated and stored a PDF for this
//      row, that file is what the customer gets. It lives in a private Storage
//      bucket, which means it cannot be fetched by URL — a signed URL is minted
//      for this customer, for this object, good for ten minutes, and the file
//      comes down under its own name. See supabase/setup.sql, section 12.
//
//   2. A GENERATED ONE. Until the nightly job has produced a stored file — and
//      for every row already in the table that predates it — the summary is
//      rendered here, in the browser, into a genuine PDF and saved. Not an HTML
//      page with a print dialog behind it: a .pdf file in the Downloads folder,
//      which is what the button says.
//
// The second path is a fallback, not a substitute, and it says so on the face
// of the document: it is a summary of the account record, not the bank's
// audited statement. Requesting the audited one is its own action on the sheet.

// ---------- storage ----------

// Long enough to survive a slow connection and a background/foreground round
// trip, short enough that a URL found in a history log later is already dead.
const SIGNED_URL_TTL_SECONDS = 600;

// Where generated statement PDFs live. Private — see the bucket policies in
// setup.sql; the first folder of every path is the owner's user id, and that is
// what the policy checks.
export const STATEMENTS_BUCKET = 'statements';

/**
 * The stored file behind a row, if there is one.
 *
 * Column names are read defensively because these tables were populated before
 * this feature existed and different generators have used different names for
 * the same thing. A row with no path at all is not an error — it just means
 * nothing has been generated for it yet, and the caller falls back.
 */
export function storedFileFor(row, defaultBucket = STATEMENTS_BUCKET) {
  if (!row) return null;
  const path = row.storage_object_path || row.storage_path || row.file_path || '';
  if (!path) return null;
  return {
    bucket: row.storage_bucket || defaultBucket,
    path,
    fileName: row.file_name || path.split('/').pop() || 'statement.pdf',
    mimeType: row.mime_type || 'application/pdf',
  };
}

/**
 * Mints a signed URL for a private object and starts the download.
 *
 * `{ download: fileName }` is the part that matters and the part that is easy
 * to leave out: without it the signed URL serves the object inline, so a PDF
 * opens in a tab instead of being saved, and the file arrives named after its
 * storage key rather than after the statement. With it, Storage sets
 * Content-Disposition on the response — which is the only way to do this across
 * an origin, since a browser ignores the `download` attribute on a cross-origin
 * link.
 *
 * Throws if the URL cannot be minted, so the caller can fall back rather than
 * silently doing nothing.
 */
export async function downloadStoredFile(supabaseClient, file) {
  if (!supabaseClient) throw new Error('Supabase client not available');
  if (!file || !file.path) throw new Error('No stored file for this document');

  const { data, error } = await supabaseClient
    .storage
    .from(file.bucket)
    .createSignedUrl(file.path, SIGNED_URL_TTL_SECONDS, { download: file.fileName });

  if (error) throw error;
  if (!data || !data.signedUrl) throw new Error('Storage returned no signed URL');

  startDownload(data.signedUrl, file.fileName);
  return data.signedUrl;
}

// ---------- saving a file ----------

/** Clicks a link the customer never sees. The whole of "download" in a browser. */
function startDownload(href, fileName) {
  const link = document.createElement('a');
  link.href = href;
  link.download = fileName || '';
  link.rel = 'noopener';
  // Firefox will not follow a link that is not in the document.
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  startDownload(url, fileName);
  // Not revoked immediately: the click is asynchronous, and revoking the URL
  // before the browser has read it cancels the download it just started.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** `Portfolio Statement`, `August 2026` -> `verceil-portfolio-statement-august-2026.pdf` */
export function documentFileName(...parts) {
  const slug = parts
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `verceil-${slug || 'document'}.pdf`;
}

// ---------- writing a PDF by hand ----------
//
// No library, and no CDN. Everything else in this app is vanilla and the pages
// are served under a policy that does not want another third-party script for
// the sake of one button; a one-page text document is about two hundred bytes
// of PDF structure, so it is written out directly.
//
// The format is PDF 1.4: a handful of numbered objects, then a cross-reference
// table giving the BYTE OFFSET of each one. Those offsets are why every string
// below is forced to ASCII first — one character has to be one byte, or the
// offsets are wrong and no reader will open the file.

const PAGE_WIDTH = 595.28;   // A4, in points
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const VALUE_COLUMN = 300;
const RIGHT_EDGE = PAGE_WIDTH - MARGIN;

// Helvetica has no glyph for a typographic dash or a middle dot at the encoding
// this file declares, and an em-dash written raw would also break the one byte
// per character rule the offsets depend on. Each one becomes its plain
// equivalent rather than being dropped, so `Not FDIC insured · May lose value`
// reads as a sentence rather than losing its separator.
function toAscii(value) {
  return String(value == null ? '' : value)
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2012-\u2015]/g, '-')
    .replace(/[\u00B7\u2022]/g, '-')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/\u2026/g, '...')
    // Anything still outside printable ASCII cannot be encoded in one byte, and
    // one character has to be one byte for the offsets above to hold.
    .replace(/[^\x20-\x7E]/g, '');
}

// ( ) and \ are the delimiters of a PDF string literal, so a customer whose
// account name contains one must not be able to end the string early.
function pdfString(value) {
  return toAscii(value)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

// Helvetica at 9pt averages a shade under half its point size per character;
// 96 characters is a comfortable line inside the margins with room to spare for
// a run of wide ones. Wrapping on words, never mid-word.
function wrapText(text, maxChars = 96) {
  const words = toAscii(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  words.forEach((word) => {
    if (!line.length) line = word;
    else if (line.length + 1 + word.length <= maxChars) line += ` ${word}`;
    else { lines.push(line); line = word; }
  });
  if (line.length) lines.push(line);
  return lines;
}

function textOp(x, y, size, font, value) {
  return `BT /${font} ${size} Tf ${x} ${y} Td (${pdfString(value)}) Tj ET\n`;
}

function greyTextOp(x, y, size, font, value) {
  return `q 0.42 0.46 0.53 rg ${textOp(x, y, size, font, value)}Q\n`;
}

function ruleOp(y) {
  return `q 0.8 w 0.87 0.89 0.92 RG ${MARGIN} ${y} m ${RIGHT_EDGE} ${y} l S Q\n`;
}

/**
 * A one-page statement, as a PDF Blob.
 *
 * @param {Object} doc
 * @param {string} doc.title      e.g. 'Portfolio Statement'
 * @param {string} [doc.subtitle] e.g. 'August 2026 - Account ending 4417'
 * @param {Array<[string, string]>} doc.rows  label/value pairs, in order
 * @param {string} [doc.note]     the small print under the rule
 */
export function buildStatementPdf(doc) {
  const rows = doc.rows || [];
  let content = '';
  let y = PAGE_HEIGHT - MARGIN - 14;

  content += textOp(MARGIN, y, 17, 'F2', 'Verceil Bank');
  y -= 15;
  content += greyTextOp(MARGIN, y, 9.5, 'F1', documentFooterLine());

  y -= 34;
  content += textOp(MARGIN, y, 15, 'F2', doc.title || 'Account Document');
  if (doc.subtitle) {
    y -= 16;
    content += greyTextOp(MARGIN, y, 10.5, 'F1', doc.subtitle);
  }

  y -= 18;
  content += ruleOp(y);

  y -= 26;
  rows.forEach(([label, value]) => {
    content += greyTextOp(MARGIN, y, 10.5, 'F1', label);
    content += textOp(VALUE_COLUMN, y, 10.5, 'F2', value);
    y -= 24;
  });

  y -= 4;
  content += ruleOp(y);

  if (doc.note) {
    y -= 22;
    wrapText(doc.note).forEach((line) => {
      content += greyTextOp(MARGIN, y, 9, 'F1', line);
      y -= 13;
    });
  }

  content += greyTextOp(
    MARGIN,
    MARGIN,
    8.5,
    'F1',
    `Downloaded from the Verceil Bank app on ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`,
  );

  return new Blob([toBytes(assemblePdf(content))], { type: 'application/pdf' });
}

// The six objects every single-page PDF needs, then the cross-reference table
// that says where each one starts. `pdf.length` is the byte offset precisely
// because everything above forced the content to ASCII.
function assemblePdf(contentStream) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] `
      + '/Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${contentStream.length} >>\nstream\n${contentStream}endstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const startXref = pdf.length;
  // Every entry in this table is exactly twenty bytes wide. A reader counts
  // rather than parses, so the trailing space before each newline is load
  // bearing.
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((offset) => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;
  return pdf;
}

function toBytes(text) {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xFF;
  return bytes;
}

// ---------- the whole of "Download PDF", in one call ----------

/**
 * Stored file if the bank has one, generated summary if it does not.
 *
 * Resolves to 'stored' or 'generated' so the caller can say which the customer
 * got, and rejects only when both paths have failed — at which point there is
 * genuinely nothing to hand over and the customer should be told so rather than
 * being left looking at a sheet that closed and did nothing.
 */
export async function downloadDocument({ supabaseClient, row, bucket, fileName, pdf }) {
  const stored = storedFileFor(row, bucket || STATEMENTS_BUCKET);

  if (stored && supabaseClient) {
    try {
      await downloadStoredFile(supabaseClient, stored);
      return 'stored';
    } catch (err) {
      // A path in the row and no object behind it is the bank's problem, not
      // the customer's: log it, and give them the summary rather than an error.
      console.error('Stored document download failed, falling back:', err);
    }
  }

  saveBlob(buildStatementPdf(pdf), fileName);
  return 'generated';
}
