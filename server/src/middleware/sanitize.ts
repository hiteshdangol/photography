import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Strips MongoDB operator injection from user input.
 *
 * `express-mongo-sanitize` cannot be used here: Express 5 makes `req.query` a
 * read-only getter, and the library assigns to it. This walks the mutable
 * segments instead, and rehydrates `req.query` into a plain sanitized object.
 */
const FORBIDDEN_KEY = /^\$|\./;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recursively removes `$`-prefixed keys and keys containing a dot. */
export function sanitizeValue<T>(input: T, depth = 0): T {
  if (depth > 12) return input;
  if (Array.isArray(input)) {
    return input.map((item) => sanitizeValue(item, depth + 1)) as unknown as T;
  }
  if (isPlainObject(input)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (FORBIDDEN_KEY.test(key)) continue;
      out[key] = sanitizeValue(value, depth + 1);
    }
    return out as unknown as T;
  }
  return input;
}

export const sanitizeRequest: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  if (req.body) req.body = sanitizeValue(req.body);
  if (req.params) req.params = sanitizeValue(req.params);

  if (req.query && typeof req.query === 'object') {
    // In Express 5 `req.query` is a lazily-computed getter with no setter, so we
    // shadow it with an own property holding the sanitized copy.
    try {
      Object.defineProperty(req, 'query', {
        value: sanitizeValue({ ...(req.query as Record<string, unknown>) }),
        writable: true,
        configurable: true,
        enumerable: true,
      });
    } catch {
      /* best effort - the value schemas still reject unknown operators */
    }
  }
  next();
};
