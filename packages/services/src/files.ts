import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

/**
 * Upload checks (Tech Spec §7 "Input"): the type is sniffed from the bytes, never trusted from
 * the client, and images are re-encoded from their pixels. Re-encoding drops everything that is
 * not the picture: EXIF and GPS, comments, XMP, MPF/depth/gain-map images appended after the
 * first image, and Motion Photo trailers (BUG-105).
 */
export type AllowedType = 'image/jpeg' | 'image/png' | 'application/pdf';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** A phone photo is 12–50 MP; anything larger is refused before decoding into memory. */
const MAX_MEGAPIXELS = 60;
const JPEG_QUALITY = 85;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function sniffType(b: Buffer): AllowedType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

function reencodeJpeg(b: Buffer): Buffer | null {
  try {
    const img = jpeg.decode(b, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: MAX_MEGAPIXELS,
      maxMemoryUsageInMB: 1024,
    });
    return jpeg.encode({ width: img.width, height: img.height, data: img.data }, JPEG_QUALITY).data;
  } catch {
    return null;
  }
}

function reencodePng(b: Buffer): Buffer | null {
  try {
    const img = PNG.sync.read(b);
    if (img.width * img.height > MAX_MEGAPIXELS * 1_000_000) return null;
    // A fresh PNG carries only IHDR, IDAT and IEND: no text, EXIF or time chunks.
    const out = new PNG({ width: img.width, height: img.height });
    img.data.copy(out.data);
    return PNG.sync.write(out);
  } catch {
    return null;
  }
}

/**
 * Sniffs and cleans an upload; null when it is not an allowed, decodable file. PDFs are kept as
 * uploaded (they are not rendered by the app and are served as downloads, never inline).
 */
export function cleanUpload(b: Buffer): { type: AllowedType; bytes: Buffer } | null {
  const type = sniffType(b);
  if (type === 'image/jpeg') {
    const bytes = reencodeJpeg(b);
    return bytes ? { type, bytes } : null;
  }
  if (type === 'image/png') {
    const bytes = reencodePng(b);
    return bytes ? { type, bytes } : null;
  }
  return type ? { type, bytes: b } : null;
}
