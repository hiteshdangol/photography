import sharp from 'sharp';
import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { UPLOAD_ERRORS } from '../../messages.js';
import { ApiError } from '../../utils/ApiError.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('image');

sharp.cache({ files: 0, items: 60, memory: 48 });
sharp.concurrency(2);

export type ImageVariant = 'original' | 'gallery' | 'thumbnail' | 'preview';

export interface RenditionBuffers {
  original: Buffer;
  optimized: Buffer;
  thumbnail: Buffer;
  preview: Buffer;
}

export interface ProcessedImage {
  /** Storage keys relative to the bucket root, e.g. `2026-09/photos/abc_1600.webp`. */
  originalKey: string;
  optimizedKey: string;
  thumbnailKey: string;
  previewKey: string;

  originalSize: number;
  optimizedSize: number;
  thumbnailSize: number;

  /** Dimensions of the gallery rendition, i.e. what the lightbox loads. */
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  aspectRatio: number;

  blurDataUrl: string;
  dominantColor: string;
  mimeType: string;
}

/** Formats Sharp is allowed to decode. Anything else is rejected outright. */
const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp']);

/** Server-generated, collision-free, path-traversal-proof filename stem. */
export function safeFilename(prefix = 'img'): string {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

export interface ImageInfo {
  format: string;
  width: number;
  height: number;
  hasAlpha: boolean;
  size: number;
}

/**
 * Authoritative upload validation.
 *
 * The filename extension, the browser-declared MIME type and any client-supplied
 * dimensions are all attacker-controlled. This decodes the actual bytes and asks
 * Sharp what the file really is, so a renamed script, an SVG, or a polyglot is
 * rejected here rather than reaching storage.
 */
export async function inspectImage(buffer: Buffer): Promise<ImageInfo> {
  if (buffer.byteLength === 0) throw ApiError.badRequest(UPLOAD_ERRORS.corrupt);
  if (buffer.byteLength > env.maxUploadBytes) {
    throw ApiError.payloadTooLarge(UPLOAD_ERRORS.tooLarge);
  }

  try {
    const meta = await sharp(buffer, { limitInputPixels: 268_402_689, failOn: 'error' }).metadata();

    if (!meta.format || !ACCEPTED_FORMATS.has(meta.format)) {
      throw ApiError.unsupportedMedia(UPLOAD_ERRORS.invalidType);
    }
    if (!meta.width || !meta.height) throw ApiError.badRequest(UPLOAD_ERRORS.corrupt);
    // Decompression-bomb guard: 100 megapixels is far beyond any real shoot.
    if (meta.width * meta.height > 100_000_000) {
      throw ApiError.badRequest('That image resolution is not supported.');
    }

    return {
      format: meta.format,
      width: meta.width,
      height: meta.height,
      hasAlpha: meta.format === 'png' || meta.hasAlpha === true,
      size: buffer.byteLength,
    };
  } catch (error) {
    // Re-throw our own ApiErrors; convert decode failures to a clean 415.
    if (error instanceof ApiError) throw error;
    throw ApiError.unsupportedMedia(UPLOAD_ERRORS.invalidType);
  }
}

/** Tiny inline placeholder for the blur-up / progressive loading effect. */
export async function buildBlurDataUrl(buffer: Buffer): Promise<string> {
  try {
    const out = await sharp(buffer)
      .rotate()
      .resize({ width: 24, height: 24, fit: 'inside' })
      .webp({ quality: 40 })
      .toBuffer();
    return `data:image/webp;base64,${out.toString('base64')}`;
  } catch {
    return '';
  }
}

export async function dominantColour(buffer: Buffer): Promise<string> {
  try {
    const { dominant } = await sharp(buffer).resize(1, 1).stats();
    return `#${[dominant.r, dominant.g, dominant.b]
      .map((v) => Math.round(v).toString(16).padStart(2, '0'))
      .join('')}`;
  } catch {
    return '#1a1a1a';
  }
}

/**
 * Produce the renditions the gallery needs:
 *
 *   original  - decoded, auto-rotated, metadata-stripped. Never served to
 *               clients unless original downloads are explicitly enabled.
 *   gallery   - env.GALLERY_WIDTH (1600px): what the lightbox loads.
 *   thumbnail - env.THUMB_WIDTH  (400px):  what the grid loads.
 *   preview   - 48px tile behind the blur placeholder.
 *
 * EXIF is stripped everywhere: GPS coordinates in a client-facing gallery are a
 * privacy leak, and camera serials are too.
 *
 * Buffers are returned rather than written so the caller can control ordering
 * between storage writes and the database write.
 */
export async function processImage(
  buffer: Buffer,
  baseName: string,
  bucket = 'photos',
): Promise<{ image: ProcessedImage; buffers: RenditionBuffers }> {
  const inspected = await inspectImage(buffer);
  const targetFormat = env.IMAGE_FORMAT;
  const quality = targetFormat === 'webp' ? 82 : 84;
  const ext = targetFormat === 'webp' ? 'webp' : 'jpg';
  const dir = `${new Date().toISOString().slice(0, 7)}/${bucket}`;

  // `.rotate()` with no argument honours the EXIF orientation flag, so portrait
  // shots are not sideways in the gallery.
  const base = sharp(buffer, { failOn: 'warning' }).rotate();

  // Sharp strips metadata unless `.withMetadata()` is called, so not calling it
  // is what removes EXIF/GPS. That matters here: GPS coordinates baked into a
  // client-facing gallery are a privacy leak, as are camera serials.
  const originalBuffer = await base.clone().jpeg({ quality: 95, mozjpeg: true }).toBuffer();

  const optimizedBuffer = await base
    .clone()
    .resize({ width: env.GALLERY_WIDTH, withoutEnlargement: true, fit: 'inside' })
    .toFormat(targetFormat, { quality })
    .toBuffer();

  const thumbnailBuffer = await base
    .clone()
    .resize({ width: env.THUMB_WIDTH, withoutEnlargement: true, fit: 'inside' })
    .toFormat(targetFormat, { quality: 70 })
    .toBuffer();

  const previewBuffer = await base
    .clone()
    .resize({ width: 48, withoutEnlargement: true, fit: 'inside' })
    .toFormat('webp', { quality: 45 })
    .toBuffer();

  const [galleryMeta, blurDataUrl, dominant] = await Promise.all([
    sharp(optimizedBuffer).metadata(),
    buildBlurDataUrl(buffer),
    dominantColour(buffer),
  ]);

  const width = galleryMeta.width ?? inspected.width;
  const height = galleryMeta.height ?? inspected.height;

  log.debug('processed', { baseName, from: `${inspected.width}x${inspected.height}`, to: `${width}x${height}` });

  return {
    image: {
      originalKey: `${dir}/${baseName}_orig.jpg`,
      optimizedKey: `${dir}/${baseName}_${env.GALLERY_WIDTH}.${ext}`,
      thumbnailKey: `${dir}/${baseName}_${env.THUMB_WIDTH}.${ext}`,
      previewKey: `${dir}/${baseName}_preview.webp`,
      originalSize: originalBuffer.byteLength,
      optimizedSize: optimizedBuffer.byteLength,
      thumbnailSize: thumbnailBuffer.byteLength,
      width,
      height,
      originalWidth: inspected.width,
      originalHeight: inspected.height,
      aspectRatio: height === 0 ? 1.5 : width / height,
      blurDataUrl,
      dominantColor: dominant,
      mimeType: targetFormat === 'webp' ? 'image/webp' : 'image/jpeg',
    },
    buffers: {
      original: originalBuffer,
      optimized: optimizedBuffer,
      thumbnail: thumbnailBuffer,
      preview: previewBuffer,
    },
  };
}

/** Which storage key on the Photo document a given variant should stream. */
export function keyForVariant(
  image: { originalKey: string; optimizedKey: string; thumbnailKey: string; previewKey?: string },
  variant: ImageVariant,
): string {
  switch (variant) {
    case 'thumbnail':
      return image.thumbnailKey;
    case 'preview':
      return image.previewKey ?? image.thumbnailKey;
    case 'original':
      return image.originalKey;
    case 'gallery':
    default:
      return image.optimizedKey;
  }
}

export function variantDimensions(
  image: { width: number; height: number; originalWidth: number; originalHeight: number },
  variant: ImageVariant,
): { width: number; height: number } | null {
  if (variant === 'original') {
    return {
      width: image.originalWidth || image.width,
      height: image.originalHeight || image.height,
    };
  }
  if (variant === 'thumbnail' || variant === 'preview') return null; // derived from aspectRatio
  return { width: image.width, height: image.height };
}

export { log as imageLogger };
