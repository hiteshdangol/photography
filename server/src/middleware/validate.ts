import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';
import { ApiError, formatZodError } from '../utils/ApiError.js';

type Source = 'body' | 'query' | 'params';

/**
 * Validates and *replaces* the given request segment with the parsed value, so
 * controllers only ever see coerced, stripped, whitelisted data. Unknown keys
 * are dropped because every schema is a plain `z.object` (not passthrough).
 */
export function validateBody<T extends ZodType>(schema: T): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      return next(ApiError.validation('Please check the highlighted fields.', formatZodError(result.error)));
    }
    req.body = result.data;
    return next();
  };
}

export function validateQuery<T extends ZodType>(schema: T): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query ?? {});
    if (!result.success) {
      return next(ApiError.badRequest('Invalid query parameters.', formatZodError(result.error)));
    }
    // Express 5 exposes req.query as a getter, so it cannot be reassigned.
    // Stash the parsed value where controllers can read it safely.
    Object.defineProperty(req, 'validatedQuery', { value: result.data, configurable: true });
    return next();
  };
}

export function validateParams<T extends ZodType>(schema: T): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.params ?? {});
    if (!result.success) {
      return next(ApiError.badRequest('Invalid request parameters.', formatZodError(result.error)));
    }
    req.params = result.data as Request['params'];
    return next();
  };
}

/** Reads the output of `validateQuery` with a typed cast. */
export function q<T>(req: Request): T {
  return (req as Request & { validatedQuery: T }).validatedQuery;
}

export type { Source };
