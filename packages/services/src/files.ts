import sharp from 'sharp';

/**
 * Upload checks (Tech Spec §7 "Input"): the type is sniffed from the bytes, never trusted from
 * the client, and images are re-encoded from their pixels. Re-encoding drops everything that is
 * not the picture: EXIF and GPS, comments, XMP, MPF/depth/gain-map images appended after the
 * first image, and Motion Photo trailers (BUG-105).
 *
 * Decoding runs in sharp (libvips) on its own threads, and the pixel count is checked from the
 * header before any pixels are decoded, so a small file declaring a huge image is refused at once
 * and a large photo never blocks the event loop (BUG-183).
 */
export type AllowedType = 'image/jpeg' | 'image/png' | 'application/pdf';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** A phone photo is 12–50 MP (the app downscales before upload); anything larger is refused. */
export const MAX_PIXELS = 50_000_000;
const JPEG_QUALITY = 85;
const THUMB_EDGE = 240;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function sniffType(b: Buffer): AllowedType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

const SHARP_FORMAT: Record<'image/jpeg' | 'image/png', string> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
};

export interface CleanFile {
  type: AllowedType;
  bytes: Buffer;
  /** Images only. */
  thumbnail: Buffer | null;
}

async function cleanImage(b: Buffer, type: 'image/jpeg' | 'image/png'): Promise<CleanFile | null> {
  const open = () => sharp(b, { limitInputPixels: MAX_PIXELS, failOn: 'error', pages: 1 });
  try {
    // Header only: format and size, before anything is decoded.
    const meta = await open().metadata();
    if (meta.format !== SHARP_FORMAT[type] || !meta.width || !meta.height) return null;
    if (meta.width * meta.height > MAX_PIXELS) return null;
    // `rotate()` applies the EXIF orientation to the pixels, since the tag itself is dropped.
    const image = open().rotate();
    const bytes = await (
      type === 'image/jpeg' ? image.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }) : image.png()
    ).toBuffer();
    // A small JPEG for list and approval cards: loading cards never fetches, or audits, the full
    // photo (BUG-110).
    const thumbnail = await open()
      .rotate()
      .resize(THUMB_EDGE, THUMB_EDGE, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 70 })
      .toBuffer();
    return { type, bytes, thumbnail };
  } catch {
    return null;
  }
}

/**
 * Sniffs and cleans an upload; null when it is not an allowed, decodable file. PDFs are kept as
 * uploaded (they are not rendered by the app and are served as downloads, never inline).
 */
export async function cleanUpload(b: Buffer): Promise<CleanFile | null> {
  const type = sniffType(b);
  if (type === 'application/pdf') return { type, bytes: b, thumbnail: null };
  if (!type) return null;
  return cleanImage(b, type);
}
