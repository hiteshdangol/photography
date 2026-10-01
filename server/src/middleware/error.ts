import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { createLogger } from '../utils/logger.js';
import { env as validatedEnv } from '../config/env.js';

const log = createLogger('error');

/** Consistent error envelope. Nothing internal ever reaches the client. */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const requestId = req.requestId ?? '-';

  if (error instanceof ApiError) {
    if (error.status >= 500) log.error(error.message, { requestId, path: req.originalUrl });
    else log.debug(error.message, { requestId, status: error.status });
    res.status(error.status).json({
      success: false,
      message: error.message,
      code: error.code,
      ...(error.details ? { errors: error.details } : {}),
      requestId,
    });
    return;
  }

  // Mongoose validation / cast / duplicate-key errors mapped to 4xx.
  if (isMongoError(error)) {
    const mapped = mapMongoError(error);
    log.warn(mapped.message, { requestId, code: mapped.code });
    res.status(mapped.status).json({
      success: false,
      message: mapped.message,
      code: mapped.code,
      ...(mapped.details ? { errors: mapped.details } : {}),
      requestId,
    });
    return;
  }

  // Multer
  if (isMulterError(error)) {
    const message =
      error.code === 'LIMIT_FILE_SIZE'
        ? 'That file is too large.'
        : error.code === 'LIMIT_FILE_COUNT'
          ? 'Too many files in one upload.'
          : 'Upload failed. Please try again.';
    res.status(413).json({ success: false, message, code: 'upload_error', requestId });
    return;
  }

  // Malformed JSON body
  if (isBodyParserError(error)) {
    res.status(400).json({ success: false, message: 'Malformed request body.', code: 'bad_request', requestId });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  log.error('unhandled error', {
    requestId,
    path: req.originalUrl,
    method: req.method,
    message,
    stack: env.isProduction ? undefined : error instanceof Error ? error.stack : undefined,
  });

  res.status(500).json({
    success: false,
    message: 'Something went wrong on our end. Please try again.',
    code: 'internal_error',
    ...(env.isProduction ? {} : { debug: message }),
    requestId,
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    message: `No API route matches ${req.method} ${req.path}.`,
    code: 'not_found',
  });
}

interface MongoLikeError {
  name?: string;
  code?: number;
  keyPattern?: Record<string, unknown>;
  keyValue?: Record<string, unknown>;
  errors?: Record<string, { message?: string }>;
  message?: string;
}

function isMongoError(error: unknown): error is MongoLikeError {
  if (!error || typeof error !== 'object') return false;
  const name = (error as MongoLikeError).name ?? '';
  return (
    name === 'ValidationError' ||
    name === 'CastError' ||
    name === 'MongoServerError' ||
    (error as MongoLikeError).code === 11000
  );
}

function mapMongoError(error: MongoLikeError): { status: number; message: string; code: string; details?: unknown } {
  if (error.code === 11000) {
    const field = Object.keys(error.keyPattern ?? error.keyValue ?? {})[0] ?? 'value';
    const label = field.replace(/Id$/, '').replace(/([A-Z])/g, ' $1').toLowerCase();
    return {
      status: 409,
      message: `That ${label} is already taken.`,
      code: 'duplicate_key',
      details: [{ field, message: 'Already in use.' }],
    };
  }
  if (error.name === 'ValidationError') {
    const details = Object.entries(error.errors ?? {}).map(([field, detail]) => ({
      field,
      message: detail?.message ?? 'Invalid value.',
    }));
    return { status: 422, message: 'Please check the highlighted fields.', code: 'validation_error', details };
  }
  if (error.name === 'CastError') {
    return { status: 400, message: 'Invalid identifier.', code: 'bad_request' };
  }
  return { status: 400, message: 'The request could not be completed.', code: 'bad_request' };
}

function isMulterError(error: unknown): error is { code: string } {
  return Boolean(
    error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' &&
      /^(LIMIT_|UNEXPECTED_FILE)/.test((error as { code: string }).code),
  );
}

function isBodyParserError(error: unknown): boolean {
  return (
    error instanceof SyntaxError &&
    'body' in (error as unknown as Record<string, unknown>)
  );
}

export { validatedEnv };
