import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { UserModel } from '../models/User.js';
import { createLogger } from '../utils/logger.js';
import type { RequestContext } from '../types/express.js';

const log = createLogger('auth');

export interface AccessTokenPayload {
  sub: string;
  role: string;
  email: string;
  /** The tenant this token acts within. Null for clients and superadmin. */
  tid: string | null;
  sid: string;
}

export function signAccessToken(payload: Omit<AccessTokenPayload, 'sub'> & { sub: string }): string {
  return jwt.sign(
    { role: payload.role, email: payload.email, tid: payload.tid, sid: payload.sid },
    env.JWT_SECRET,
    { subject: payload.sub, expiresIn: env.JWT_ACCESS_TTL } as jwt.SignOptions,
  );
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET) as jwt.JwtPayload;
  if (!decoded.sub) throw ApiError.unauthorized('Your session is malformed. Please sign in again.');
  return {
    sub: String(decoded.sub),
    role: String((decoded as Record<string, unknown>).role ?? ''),
    email: String((decoded as Record<string, unknown>).email ?? ''),
    tid: ((decoded as Record<string, unknown>).tid as string | null) ?? null,
    sid: String((decoded as Record<string, unknown>).sid ?? ''),
  };
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !value) return null;
  return value.trim() || null;
}

/**
 * Verifies the access token and re-checks the account is still usable.
 *
 * The database lookup is deliberate: a suspended photographer or a deleted
 * account must not keep working until their 15-minute token expires, and
 * changing a password must invalidate already-issued access tokens.
 */
export const authenticate: RequestHandler = async (req: Request, _res: Response, next: NextFunction) => {
  const token = bearerToken(req);
  if (!token) return next(ApiError.unauthorized());

  try {
    const payload = verifyAccessToken(token);
    const user = await UserModel.findById(payload.sub)
      .select('_id email role status name')
      .lean();
    if (!user) return next(ApiError.unauthorized('Your account no longer exists.'));
    if (user.status === 'suspended') {
      return next(ApiError.forbidden('This account has been suspended. Contact support for help.'));
    }

    req.ctx = {
      userId: user._id as RequestContext['userId'],
      role: user.role as RequestContext['role'],
      email: user.email,
      // A photographer's tenant is always their own user id. It is never read
      // from the request, so a client can never claim to be a tenant.
      tenantId: user.role === 'photographer' ? user._id : null,
      sessionId: payload.sid,
    };
    return next();
  } catch (error) {
    if (error instanceof ApiError) return next(error);
    return next(ApiError.unauthorized('Your session has expired. Please sign in again.'));
  }
};

/** Populates `req.ctx` when a valid token is present, but never rejects. */
export const optionalAuthenticate: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (!bearerToken(req)) return next();
  return authenticate(req, res, (error?: unknown) => next(error instanceof ApiError ? undefined : error));
};

export function requireRole(...roles: RequestContext['role'][]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.ctx) return next(ApiError.unauthorized());
    if (!roles.includes(req.ctx.role)) {
      log.warn('role gate rejected', { userId: String(req.ctx.userId), role: req.ctx.role, allowed: roles });
      return next(ApiError.forbidden('Your account does not have access to this feature.'));
    }
    return next();
  };
}

export const requireSuperAdmin: RequestHandler = requireRole('superadmin');
export const requirePhotographer: RequestHandler = requireRole('photographer');
export const requireClient: RequestHandler = requireRole('client');
