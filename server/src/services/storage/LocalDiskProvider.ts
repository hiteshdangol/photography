import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { UPLOAD_ROOT } from '../../config/env.js';
import { STORAGE_KEYS } from '../../config/constants.js';
import {
  assertSafeKey,
  type PutOptions,
  type StorageProvider,
  type StorageStat,
  type StoredObject,
} from './StorageProvider.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('storage:local');

const CONTENT_TYPES: Record<string, string> = {
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
  '.eml': 'message/rfc822',
};

export class LocalDiskProvider implements StorageProvider {
  readonly name = 'local';
  readonly supportsSignedUrls = false;

  constructor(private readonly root: string = UPLOAD_ROOT) {
    for (const bucket of STORAGE_KEYS) {
      fs.mkdirSync(path.join(this.root, bucket), { recursive: true });
    }
  }

  private resolve(key: string): string {
    assertSafeKey(key);
    const resolved = path.resolve(this.root, key);
    // Defence in depth: even with a validated key, confirm the result is still
    // inside the upload root before touching the filesystem.
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (!resolved.startsWith(rootWithSep)) throw new Error('Storage key escapes the upload root.');
    return resolved;
  }

  async put(body: Buffer, options: PutOptions): Promise<StoredObject> {
    const fullKey = `${options.bucket}/${options.key}`;
    const target = this.resolve(fullKey);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, body, { flag: 'wx' }).catch(async (error: NodeJS.ErrnoException) => {
      // `wx` fails if the key already exists; keys are random, so a collision
      // means something is wrong - surface it rather than overwriting.
      if (error.code !== 'EEXIST') throw error;
      throw new Error(`Storage key already exists: ${fullKey}`);
    });
    return {
      key: fullKey,
      size: body.byteLength,
      contentType: options.contentType || CONTENT_TYPES[path.extname(fullKey)] || 'application/octet-stream',
    };
  }

  async getStream(key: string): Promise<Readable> {
    const target = this.resolve(key);
    try {
      await fsp.access(target, fs.constants.R_OK);
    } catch {
      throw Object.assign(new Error(`Storage object not found: ${key}`), { code: 'ENOENT' });
    }
    return fs.createReadStream(target);
  }

  async getBuffer(key: string): Promise<Buffer> {
    return fsp.readFile(this.resolve(key));
  }

  async stat(key: string): Promise<StorageStat | null> {
    try {
      const info = await fsp.stat(this.resolve(key));
      return {
        size: info.size,
        contentType: CONTENT_TYPES[path.extname(key).toLowerCase()],
        lastModified: info.mtime,
      };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await fsp.unlink(this.resolve(key)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fsp.access(this.resolve(key), fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async usage(): Promise<{ bytes: number; objects: number }> {
    let bytes = 0;
    let objects = 0;
    const walk = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          const info = await fsp.stat(full).catch(() => null);
          if (info) {
            bytes += info.size;
            objects += 1;
          }
        }
      }
    };
    await walk(this.root);
    log.debug('usage', { bytes, objects });
    return { bytes, objects };
  }
}
