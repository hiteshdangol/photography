import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import type { Types } from 'mongoose';
import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { UserModel } from '../models/User.js';
import { RefreshTokenModel } from '../models/RefreshToken.js';
import { VerificationTokenModel } from '../models/VerificationToken.js';
import { PhotographerProfileModel } from '../models/PhotographerProfile.js';
import { ClientProfileModel } from '../models/ClientProfile.js';
import { signAccessToken } from '../middleware/auth.js';
import { clearRefreshCookie, setRefreshCookie } from '../middleware/cookies.js';
import { sha256 } from '../utils/crypto.js';
import { slugify, uniqueSlug } from '../utils/slug.js';
import { createLogger } from '../utils/logger.js';
import type { UserRole } from '../config/constants.js';

const log = createLogger('auth.service');

export interface AuthResult {
  user: Record<string, unknown>;
  accessToken: string;
  expiresIn: string;
}

interface SessionMeta {
  ip?: string;
  userAgent?: string;
}

function sessionMeta(req: Request): SessionMeta {
  return { ip: req.ip, userAgent: (req.headers['user-agent'] ?? '').slice(0, 300) };
}

/** `15m` -> 900000, so the cookie Max-Age and the token TTL cannot drift apart. */
function ttlToMs(ttl: string): number {
  const match = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!match) return 15 * 60 * 1000;
  const value = Number(match[1]);
  const unit = match[2];
  const factor = unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000;
  return value * factor;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, env.BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * Mints a refresh token and its access-token companion.
 *
 * Every login starts a new *family*. Refresh rotates within the family; if an
 * already-rotated token is ever presented, the family is treated as stolen and
 * every descendant is revoked.
 */
async function issueSession(
  user: { _id: Types.ObjectId; role: string; email: string },
  res: Response,
  meta: SessionMeta,
  familyId = crypto.randomUUID(),
): Promise<Pick<AuthResult, 'accessToken' | 'expiresIn'>> {
  const rawRefresh = crypto.randomBytes(48).toString('base64url');
  const sessionId = crypto.randomUUID();

  await RefreshTokenModel.create({
    userId: user._id,
    tokenHash: sha256(rawRefresh),
    familyId,
    expiresAt: new Date(Date.now() + ttlToMs(env.JWT_REFRESH_TTL)),
    userAgent: meta.userAgent ?? '',
    ip: meta.ip ?? '',
  });

  const accessToken = signAccessToken({
    sub: String(user._id),
    role: user.role,
    email: user.email,
    tid: user.role === 'photographer' ? String(user._id) : null,
    sid: sessionId,
  });

  setRefreshCookie(res, rawRefresh, ttlToMs(env.JWT_REFRESH_TTL));

  return { accessToken, expiresIn: env.JWT_ACCESS_TTL };
}

export function publicUser(user: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(user._id ?? user.id),
    name: user.name,
    email: user.email,
    role: user.role,
    phone: user.phone ?? null,
    avatar: user.avatar ?? null,
    status: user.status,
    emailVerified: Boolean(user.emailVerified),
    createdAt: user.createdAt,
  };
}

export async function register(
  input: { name: string; email: string; password: string; phone?: string; role: UserRole },
  req: Request,
  res: Response,
): Promise<AuthResult> {
  const email = input.email.toLowerCase();
  const existing = await UserModel.findOne({ email }).select('_id').lean();
  if (existing) {
    throw ApiError.conflict('An account with that email already exists.');
  }

  const user = await UserModel.create({
    name: input.name,
    email,
    password: await hashPassword(input.password),
    role: input.role,
    phone: input.phone ?? null,
    // Super admins are provisioned by an operator, never self-registered.
    ...(input.role === 'superadmin' ? { status: 'pending_verification' } : {}),
  });

  // Provision the role profile in the same logical step as the account.
  if (input.role === 'photographer') {
    const baseSlug = await uniqueSlug(
      slugify(input.name) || 'photographer',
      async (candidate) => Boolean(await PhotographerProfileModel.findOne({ slug: candidate }).select('_id').lean()),
    );
    await PhotographerProfileModel.create({
      userId: user._id,
      businessName: input.name,
      slug: baseSlug,
      bio: '',
      location: '',
    });
  } else if (input.role === 'client') {
    await ClientProfileModel.create({ userId: user._id, photographerIds: [] });
  }

  const session = await issueSession(user, res, sessionMeta(req));
  log.info('registered', { userId: String(user._id), role: user.role });

  return { ...session, user: publicUser(user.toObject()) };
}
export async function login(
  input: { email: string; password: string },
  req: Request,
  res: Response,
): Promise<AuthResult> {
  const email = input.email.toLowerCase();
  const user = await UserModel.findOne({ email }).select('+password');

  // Always run a hash comparison so the response time does not reveal whether
  // the account exists. Uses a fixed dummy hash when the user is not found.
  const DUMMY = '$2b$12$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012';
  const ok = await verifyPassword(input.password, user?.password ?? DUMMY);

  if (!user || !ok) {
    throw ApiError.unauthorized('Incorrect email or password.');
  }
  if (user.status === 'suspended') {
    throw ApiError.forbidden('This account has been suspended. Please contact support.');
  }

  user.lastLoginAt = new Date();
  await user.save({ validateBeforeSave: false });

  const session = await issueSession(user, res, sessionMeta(req));
  log.info('logged in', { userId: String(user._id), role: user.role });

  return { ...session, user: publicUser(user.toObject()) };
}

/**
 * Rotating refresh. Returns a fresh access token and a fresh refresh cookie.
 *
 * Reuse detection: if the presented token is already revoked but still known,
 * someone replayed a stolen token, so the whole family is killed and the user
 * must sign in again.
 */
export async function refresh(req: Request, res: Response): Promise<AuthResult> {
  const raw = (req.cookies as Record<string, string> | undefined)?.lf_rt;
  if (!raw) throw ApiError.unauthorized('No active session. Please sign in.');

  const tokenHash = sha256(raw);
  const record = await RefreshTokenModel.findOne({ tokenHash });

  if (!record) {
    throw ApiError.unauthorized('Your session is no longer valid. Please sign in.');
  }

  if (record.revokedAt) {
    await RefreshTokenModel.updateMany(
      { familyId: record.familyId, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: 'reuse_detected' } },
    );
    log.warn('refresh token reuse detected; family revoked', {
      userId: String(record.userId),
      familyId: record.familyId,
    });
    clearRefreshCookie(res);
    throw ApiError.unauthorized('Your session was ended for security reasons. Please sign in again.');
  }

  if (record.expiresAt.getTime() < Date.now()) {
    clearRefreshCookie(res);
    throw ApiError.unauthorized('Your session has expired. Please sign in.');
  }

  const user = await UserModel.findById(record.userId);
  if (!user) {
    clearRefreshCookie(res);
    throw ApiError.unauthorized('Your account no longer exists.');
  }
  if (user.status === 'suspended') {
    clearRefreshCookie(res);
    throw ApiError.forbidden('This account has been suspended.');
  }

  // Rotate: mark the old token replaced, then issue a new one in the same family.
  const nextRaw = crypto.randomBytes(48).toString('base64url');
  const nextHash = sha256(nextRaw);
  const expiresAt = new Date(Date.now() + ttlToMs(env.JWT_REFRESH_TTL));

  record.revokedAt = new Date();
  record.replacedByHash = nextHash;
  record.revokedReason = 'rotated';
  record.lastUsedAt = new Date();
  await record.save();

  await RefreshTokenModel.create({
    userId: user._id,
    tokenHash: nextHash,
    familyId: record.familyId,
    expiresAt,
    userAgent: sessionMeta(req).userAgent ?? '',
    ip: sessionMeta(req).ip ?? '',
  });

  setRefreshCookie(res, nextRaw, ttlToMs(env.JWT_REFRESH_TTL));

  const accessToken = signAccessToken({
    sub: String(user._id),
    role: user.role,
    email: user.email,
    tid: user.role === 'photographer' ? String(user._id) : null,
    sid: crypto.randomUUID(),
  });

  return { accessToken, expiresIn: env.JWT_ACCESS_TTL, user: publicUser(user.toObject()) };
}

export async function logout(req: Request, res: Response): Promise<void> {
  const raw = (req.cookies as Record<string, string> | undefined)?.lf_rt;
  if (raw) {
    const record = await RefreshTokenModel.findOne({ tokenHash: sha256(raw) });
    if (record) {
      await RefreshTokenModel.updateMany(
        { familyId: record.familyId, revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: 'logout' } },
      );
    }
  }
  clearRefreshCookie(res);
}

/** Revoke every session for an account (used on password change and by admin). */
export async function revokeAllSessions(userId: Types.ObjectId, reason: string): Promise<void> {
  await RefreshTokenModel.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
}

export async function requestPasswordReset(email: string, res: Response): Promise<{ token: string | null }> {
  const user = await UserModel.findOne({ email: email.toLowerCase() });
  // Always report success: whether an account exists must not be observable.
  if (!user) {
    log.info('password reset requested for unknown email');
    return { token: null };
  }

  const token = crypto.randomBytes(32).toString('base64url');
  await VerificationTokenModel.create({
    userId: user._id,
    purpose: 'password_reset',
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  // In development the token is written to a .eml file and logged by the mail
  // service; returning it here keeps local testing possible without a mailbox.
  return { token: env.isProduction ? null : token };
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const record = await VerificationTokenModel.findOne({
    tokenHash: sha256(token),
    purpose: 'password_reset',
    usedAt: null,
  });
  if (!record || record.expiresAt.getTime() < Date.now()) {
    throw ApiError.badRequest('That reset link is invalid or has expired.');
  }

  const user = await UserModel.findById(record.userId).select('+password');
  if (!user) throw ApiError.badRequest('That reset link is invalid or has expired.');

  user.password = await hashPassword(newPassword);
  user.passwordChangedAt = new Date();
  user.passwordResetTokenHash = null;
  user.passwordResetExpiresAt = null;
  await user.save();

  record.usedAt = new Date();
  await record.save();

  // A password change must end every existing session.
  await revokeAllSessions(user._id, 'password_reset');
  log.info('password reset completed', { userId: String(user._id) });
}

export async function changePassword(
  userId: Types.ObjectId,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await UserModel.findById(userId).select('+password');
  if (!user) throw ApiError.notFound('Account not found.');

  const ok = await verifyPassword(currentPassword, user.password);
  if (!ok) throw ApiError.badRequest('Your current password is incorrect.');

  user.password = await hashPassword(newPassword);
  user.passwordChangedAt = new Date();
  await user.save();
  await revokeAllSessions(user._id, 'password_changed');
}

export async function issueEmailVerification(userId: Types.ObjectId): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  await VerificationTokenModel.create({
    userId,
    purpose: 'email_verification',
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  return token;
}

export async function verifyEmail(token: string): Promise<void> {
  const record = await VerificationTokenModel.findOne({
    tokenHash: sha256(token),
    purpose: 'email_verification',
    usedAt: null,
  });
  if (!record || record.expiresAt.getTime() < Date.now()) {
    throw ApiError.badRequest('That verification link is invalid or has expired.');
  }
  const user = await UserModel.findById(record.userId);
  if (!user) throw ApiError.badRequest('That verification link is invalid or has expired.');

  user.emailVerified = true;
  if (user.status === 'pending_verification') user.status = 'active';
  await user.save();
  record.usedAt = new Date();
  await record.save();
}

/**
 * Decodes a refresh token expiry for the SPA so it knows when to proactively
 * refresh. Returns seconds.
 */
export function refreshTtlSeconds(): number {
  return Math.floor(ttlToMs(env.JWT_REFRESH_TTL) / 1000);
}

export function decodeJwtExpiry(token: string): number | null {
  try {
    const decoded = jwt.decode(token) as { exp?: number } | null;
    return decoded?.exp ?? null;
  } catch {
    return null;
  }
}
