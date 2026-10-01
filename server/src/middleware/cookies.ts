import crypto from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ApiError } from '../utils/ApiError.js';
import { COOKIE_NAMES } from '../config/constants.js';
import { env } from '../config/env.js';

/** Attaches a request id used in logs and error envelopes. */
export const requestId: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const incoming = req.headers['x-request-id'];
  req.requestId =
    (typeof incoming === 'string' && incoming.slice(0, 64)) || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
};

const baseCookie = {
  httpOnly: true,
  // `lax` still sends the cookie on the cross-origin XHR the SPA makes to
  // :5000 in development, because that is the same *site* (localhost). It does
  // not send it on cross-site POSTs, which is what protects us from CSRF.
  sameSite: 'lax' as const,
  secure: env.isProduction,
  path: '/',
};

export function setRefreshCookie(res: Response, token: string, maxAgeMs: number): void {
  res.cookie(COOKIE_NAMES.refresh, token, {
    ...baseCookie,
    maxAge: maxAgeMs,
    // Narrowed to the auth endpoints: the browser only ever needs to send it
    // to /api/auth/*, so it is not attached to photo downloads or uploads.
    path: `${env.API_PREFIX}/auth`,
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(COOKIE_NAMES.refresh, { ...baseCookie, path: `${env.API_PREFIX}/auth` });
}

export function readRefreshCookie(req: Request): string | null {
  const value = (req.cookies as Record<string, string> | undefined)?.[COOKIE_NAMES.refresh];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function requireRefreshCookie(req: Request): string {
  const token = readRefreshCookie(req);
  if (!token) throw ApiError.unauthorized('No active session. Please sign in.');
  return token;
}
