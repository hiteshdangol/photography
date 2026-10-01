import type { Readable } from 'node:stream';
import type { StorageKey } from '../../config/constants.js';

export interface PutOptions {
  /** Top-level bucket, e.g. `originals`, `thumbnails`, `portfolio`. */
  bucket: StorageKey;
  /** Path within the bucket, without a leading slash. Must not escape the bucket. */
  key: string;
  contentType: string;
  metadata?: Record<string, string>;
  cacheControl?: string;
}

export interface StoredObject {
  /** The value persisted on the model, e.g. `originals/2026/09/<id>.webp`. */
  key: string;
  size: number;
  contentType: string;
}

export interface StorageStat {
  size: number;
  contentType?: string;
  lastModified?: Date;
}

/**
 * The only seam through which the application touches bytes on disk or in a
 * bucket. Nothing outside `services/storage/` should ever build a filesystem
 * path, which is what allows S3 / Cloudinary / GCS to be dropped in later
 * without touching a single controller.
 */
export interface StorageProvider {
  readonly name: string;
  /** True when objects are addressable by a URL. Local disk is false. */
  readonly supportsSignedUrls: boolean;

  put(body: Buffer, options: PutOptions): Promise<StoredObject>;
  getStream(key: string): Promise<Readable>;
  getBuffer(key: string): Promise<Buffer>;
  stat(key: string): Promise<StorageStat | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;

  /** Total bytes used, for the admin storage-usage panel. */
  usage(): Promise<{ bytes: number; objects: number }>;
}

/** Reject keys that could escape the upload root (`..`, absolute paths, NUL). */
export function assertSafeKey(key: string): void {
  if (!key || key.length > 512) throw new Error('Invalid storage key.');
  if (key.includes('\0')) throw new Error('Invalid storage key.');
  if (key.startsWith('/') || key.startsWith('\\')) throw new Error('Invalid storage key.');
  if (/^[A-Za-z]:/.test(key)) throw new Error('Invalid storage key.');
  const segments = key.split(/[\\/]/);
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    throw new Error('Invalid storage key.');
  }
}
