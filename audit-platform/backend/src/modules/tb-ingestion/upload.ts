import type { IncomingMessage } from 'node:http';
import { DomainError } from '../../common/errors.js';
import { cleanDisplay } from './normalize.js';

const ACCEPTED_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'application/csv',
  'application/octet-stream',
]);

export interface UploadedFile {
  bytes: Buffer;
  filename: string;
  format: 'csv' | 'xlsx';
  contentType: string;
}

/**
 * Display name for an uploaded file. Only the last path segment survives,
 * invisible/control characters are stripped. It is never used to build a
 * storage key (keys are generated server-side).
 */
export function sanitizeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const clean = cleanDisplay(base).text.slice(0, 255);
  if (!clean || clean === '.' || clean === '..') throw new DomainError('invalid', 'A file name is required.');
  return clean;
}

export function formatFromFilename(filename: string): 'csv' | 'xlsx' {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'xlsx') return 'xlsx';
  if (ext === 'csv') return 'csv';
  // .xls / .xlsm / .xlsb and everything else: see docs/01 section 3.2 item 3.
  throw new DomainError('unsupported_media', 'Only .xlsx and .csv trial balances are accepted. Save macro-enabled or legacy workbooks as .xlsx first.');
}

/** Content sniffing: the extension is a claim, the bytes are the evidence. */
export function assertMagic(bytes: Buffer, format: 'csv' | 'xlsx'): void {
  const zip = bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const ole = bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  if (format === 'xlsx' && !zip) throw new DomainError('unsupported_media', 'The file is not an .xlsx workbook.');
  if (format === 'csv' && (zip || ole)) {
    throw new DomainError('unsupported_media', 'The file is a workbook, not a CSV; upload it with an .xlsx name.');
  }
}

/** Read a raw request body with a hard byte limit (the declared length is checked first). */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (Number.isFinite(declared) && declared > limit) {
    return Promise.reject(new DomainError('payload_too_large', 'The file exceeds the maximum upload size.'));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        done = true;
        req.off('data', onData);
        req.resume();                       // discard the rest; the response is sent after we reject
        reject(new DomainError('payload_too_large', 'The file exceeds the maximum upload size.'));
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => { if (!done) resolve(Buffer.concat(chunks)); });
    req.on('error', (err) => { if (!done) { done = true; reject(err); } });
  });
}

export async function receiveUpload(req: IncomingMessage, rawFilename: string, limit: number): Promise<UploadedFile> {
  const contentType = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (!ACCEPTED_TYPES.has(contentType)) {
    throw new DomainError('unsupported_media', 'Send the file as the raw request body (xlsx or csv content type).');
  }
  const filename = sanitizeFilename(rawFilename);
  const format = formatFromFilename(filename);
  const bytes = await readBody(req, limit);
  if (bytes.length === 0) throw new DomainError('invalid', 'The file is empty.');
  assertMagic(bytes, format);
  return { bytes, filename, format, contentType };
}
