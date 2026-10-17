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

interface Pixels {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Decoded RGBA pixels of a JPEG, or null when it is not decodable. */
function decodeJpeg(b: Buffer): Pixels | null {
  try {
    return jpeg.decode(b, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: MAX_MEGAPIXELS,
      maxMemoryUsageInMB: 1024,
    });
  } catch {
    return null;
  }
}

const THUMB_EDGE = 240;

/**
 * A small JPEG for list and approval cards (nearest-neighbour; it only has to be recognisable).
 * Loading cards then never fetches, or audits, the full photo (BUG-110).
 */
export function thumbnailOf(img: Pixels): Buffer {
  const scale = Math.min(1, THUMB_EDGE / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / scale));
      const si = (sy * img.width + sx) * 4;
      out.set(img.data.subarray(si, si + 4), (y * w + x) * 4);
    }
  }
  return jpeg.encode({ width: w, height: h, data: out }, 70).data;
}

function decodePng(b: Buffer): Pixels | null {
  try {
    const img = PNG.sync.read(b);
    if (img.width * img.height > MAX_MEGAPIXELS * 1_000_000) return null;
    return { width: img.width, height: img.height, data: img.data };
  } catch {
    return null;
  }
}

/** A fresh PNG carries only IHDR, IDAT and IEND: no text, EXIF or time chunks. */
function encodePng(img: Pixels): Buffer {
  const out = new PNG({ width: img.width, height: img.height });
  out.data.set(img.data);
  return PNG.sync.write(out);
}

export interface CleanFile {
  type: AllowedType;
  bytes: Buffer;
  /** Images only. */
  thumbnail: Buffer | null;
}

/**
 * Sniffs and cleans an upload; null when it is not an allowed, decodable file. PDFs are kept as
 * uploaded (they are not rendered by the app and are served as downloads, never inline).
 */
export function cleanUpload(b: Buffer): CleanFile | null {
  const type = sniffType(b);
  if (type === 'application/pdf') return { type, bytes: b, thumbnail: null };
  const img = type === 'image/jpeg' ? decodeJpeg(b) : type === 'image/png' ? decodePng(b) : null;
  if (!type || !img) return null;
  const bytes =
    type === 'image/jpeg'
      ? jpeg.encode({ width: img.width, height: img.height, data: img.data }, JPEG_QUALITY).data
      : encodePng(img);
  return { type, bytes, thumbnail: thumbnailOf(img) };
}
