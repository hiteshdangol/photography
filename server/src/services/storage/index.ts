import { env } from '../../config/env.js';
import { LocalDiskProvider } from './LocalDiskProvider.js';
import type { StorageProvider } from './StorageProvider.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('storage');

let provider: StorageProvider | null = null;

/**
 * Single entry point for all storage access.
 *
 * To move to S3 later: implement `StorageProvider`, register it below, and set
 * `STORAGE_DRIVER=s3`. No controller, service or model changes required.
 */
export function getStorage(): StorageProvider {
  if (provider) return provider;

  switch (env.STORAGE_DRIVER) {
    case 's3':
      // Intentionally not implemented yet. The driver boundary is in place and
      // every call site already goes through this factory, so adding it is a
      // single new file (see README -> "Swapping in cloud storage").
      log.warn('STORAGE_DRIVER=s3 is not implemented yet; using local disk.');
      provider = new LocalDiskProvider();
      break;
    case 'local':
    default:
      provider = new LocalDiskProvider();
      break;
  }

  return provider;
}

export function setStorage(next: StorageProvider): void {
  provider = next;
}

export * from './StorageProvider.js';
