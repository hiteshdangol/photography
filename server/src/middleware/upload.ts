import multer from 'multer';
import type { RequestHandler } from 'express';
import { env } from '../config/env.js';
import { UPLOAD_ERRORS } from '../messages.js';
import { ApiError } from '../utils/ApiError.js';

export const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/**
 * Uploads are buffered in memory, not streamed to disk.
 *
 * That is deliberate: the real file type and dimensions are only trustworthy
 * after Sharp has decoded the buffer, and multer's diskStorage would have
 * written an unvalidated attacker-supplied file to the upload directory
 * already. Buffling also means `MAX_UPLOAD_MB` is a real ceiling.
 */
const storage = multer.memoryStorage();

export const imageUpload = multer({
  storage,
  limits: {
    fileSize: env.maxUploadBytes,
    files: env.MAX_FILES_PER_REQUEST,
    fields: 24,
    parts: env.MAX_FILES_PER_REQUEST + 24,
  },
  fileFilter: (_req, file, cb) => {
    // First gate only - extension and declared MIME are both attacker
    // controlled. `validateImageBuffers` performs the authoritative check.
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype as (typeof ALLOWED_MIME_TYPES)[number])) {
      cb(ApiError.unsupportedMedia(UPLOAD_ERRORS.invalidType));
      return;
    }
    cb(null, true);
  },
});

export const singleImageUpload = imageUpload.single('file');
export const multiImageUpload = imageUpload.array('files', env.MAX_FILES_PER_REQUEST);

/** Wraps a multer middleware so its errors become clean API envelopes. */
export function runUpload(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    handler(req, res, (error?: unknown) => {
      if (!error) {
        next();
        return;
      }
      if (error instanceof ApiError) {
        next(error);
        return;
      }
      const code = (error as { code?: string }).code ?? '';
      if (code === 'LIMIT_FILE_SIZE') next(ApiError.payloadTooLarge(UPLOAD_ERRORS.tooLarge));
      else if (code === 'LIMIT_FILE_COUNT' || code === 'LIMIT_PART_COUNT') {
        next(ApiError.badRequest(UPLOAD_ERRORS.tooMany));
      } else next(ApiError.badRequest('Upload failed. Please try again.'));
    });
  };
}
