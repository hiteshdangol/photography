import rateLimit, { ipKeyGenerator, type Options } from 'express-rate-limit';
import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ratelimit');

function keyByUserOrIp(req: Request): string {
  // Authenticated callers are limited per account so one abusive client behind
  // a shared NAT cannot lock out an entire photographer.
  if (req.ctx?.userId) return `u:${String(req.ctx.userId)}`;
  return ipKeyGenerator(req.ip ?? 'unknown');
}

function make(options: Partial<Options> & { limit: number; message: string }) {
  return rateLimit({
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: keyByUserOrIp,
    handler: (_req: Request, res: Response) => {
      res.status(429).json({
        success: false,
        message: options.message,
        code: 'too_many_requests',
      });
    },
    ...options,
  });
}

/** Baseline limiter for the whole API surface. */
export const globalLimiter = make({
  windowMs: 15 * 60 * 1000,
  limit: env.isProduction ? 1000 : 5000,
  message: 'Too many requests. Please slow down and try again shortly.',
});

/** Credential endpoints: strict, and always keyed by IP. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? 'unknown'),
  handler: (_req, res) =>
    res.status(429).json({
      success: false,
      message: 'Too many attempts. Please try again in 15 minutes.',
      code: 'too_many_requests',
    }),
});

/** Uploads are expensive (decode + 3 renditions per file). */
export const uploadLimiter = make({
  windowMs: 60 * 60 * 1000,
  limit: 600,
  message: 'Upload limit reached. Please try again later.',
});

/** Payment session creation and verification. */
export const paymentLimiter = make({
  windowMs: 10 * 60 * 1000,
  limit: 40,
  message: 'Too many payment attempts. Please wait a few minutes.',
});

/** Password reset emails and public contact form. */
export const publicFormLimiter = make({
  windowMs: 60 * 60 * 1000,
  limit: 8,
  message: 'Too many submissions. Please try again later.',
});

/** Expensive analytics aggregates. */
export const analyticsLimiter = make({
  windowMs: 5 * 60 * 1000,
  limit: 120,
  message: 'Too many report requests. Please wait a moment.',
});

/** Scraper-friendly cap on the public photographer directory. */
export const directoryLimiter = make({
  windowMs: 60 * 1000,
  limit: 120,
  message: 'Slow down a little.',
});

export { ApiError, log };
