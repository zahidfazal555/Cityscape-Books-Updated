/**
 * Upload checks (Tech Spec §7 "Input"): the type is sniffed from the bytes, never trusted from
 * the client, and photo metadata (EXIF, including GPS) is removed before storing.
 */
export type AllowedType = 'image/jpeg' | 'image/png' | 'application/pdf';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export function sniffType(b: Buffer): AllowedType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (
    b.length >= 8 &&
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

/**
 * Removes APP1–APP15 segments (EXIF/XMP/vendor data) and COM comments from a JPEG, keeping APP0
 * (JFIF) and everything needed to decode. Returns null if the file is not a well-formed JPEG.
 */
export function stripJpegMetadata(b: Buffer): Buffer | null {
  const out: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1] ?? 0;
    // Start of scan: the rest is entropy-coded image data up to EOI; keep it all.
    if (marker === 0xda) {
      out.push(b.subarray(i));
      return Buffer.concat(out);
    }
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return null;
    const isMetadata = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!isMetadata) out.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return null;
}

const PNG_DROP = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);

/** Removes metadata chunks (EXIF, text, time) from a PNG. Null if it is not a well-formed PNG. */
export function stripPngMetadata(b: Buffer): Buffer | null {
  const out: Buffer[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.subarray(i + 4, i + 8).toString('latin1');
    const end = i + 12 + len;
    if (end > b.length) return null;
    if (!PNG_DROP.has(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') return Buffer.concat(out);
  }
  return null;
}

/** Sniffs and cleans an upload; null when it is not an allowed, well-formed file. */
export function cleanUpload(b: Buffer): { type: AllowedType; bytes: Buffer } | null {
  const type = sniffType(b);
  if (type === 'image/jpeg') {
    const bytes = stripJpegMetadata(b);
    return bytes ? { type, bytes } : null;
  }
  if (type === 'image/png') {
    const bytes = stripPngMetadata(b);
    return bytes ? { type, bytes } : null;
  }
  return type ? { type, bytes: b } : null;
}
