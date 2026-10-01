import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { authenticate } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { authLimiter } from '../middleware/rateLimit.js';
import * as authService from '../services/auth.service.js';
import { UserModel } from '../models/User.js';
import { PhotographerProfileModel } from '../models/PhotographerProfile.js';
import { ClientProfileModel } from '../models/ClientProfile.js';
import { publicUser } from '../services/auth.service.js';
import { ok, created } from '../utils/response.js';

const router = Router();

const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters.')
  .max(128, 'That password is too long.')
  .regex(/[a-z]/, 'Include a lowercase letter.')
  .regex(/[A-Z]/, 'Include an uppercase letter.')
  .regex(/\d/, 'Include a number.');

const emailSchema = z
  .string()
  .email('Enter a valid email address.')
  .max(160)
  .transform((v) => v.trim().toLowerCase());

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Enter your name.').max(80),
  email: emailSchema,
  password: passwordSchema,
  phone: z.string().trim().max(30).optional(),
  role: z.enum(['photographer', 'client']).default('client'),
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password.').max(128),
});

router.post(
  '/register',
  authLimiter,
  validateBody(registerSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.register(req.body, req, res);
    return created(res, result, 'Welcome to LensFlow.');
  }),
);

router.post(
  '/login',
  authLimiter,
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.login(req.body, req, res);
    return ok(res, result, 'Signed in.');
  }),
);

/**
 * Silent refresh. Called on app boot and whenever an API call returns 401.
 * The refresh token lives in an httpOnly cookie, so the SPA never handles it.
 */
router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const result = await authService.refresh(req, res);
    return ok(res, result);
  }),
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await authService.logout(req, res);
    return ok(res, { loggedOut: true }, 'Signed out.');
  }),
);

const forgotSchema = z.object({ email: emailSchema });

router.post(
  '/forgot-password',
  authLimiter,
  validateBody(forgotSchema),
  asyncHandler(async (req, res) => {
    const { token } = await authService.requestPasswordReset(req.body.email, res);
    const { emailTransport } = await import('../services/notifications/email.service.js');
    await emailTransport.sendPasswordReset(req.body.email, token);
    // The response never reveals whether the account exists.
    return ok(
      res,
      { sent: true, ...(token && !process.env.NODE_ENV ? { devResetToken: token } : {}) },
      'If that email is registered, a reset link is on its way.',
    );
  }),
);

const resetSchema = z.object({
  token: z.string().min(10),
  password: passwordSchema,
});

router.post(
  '/reset-password',
  authLimiter,
  validateBody(resetSchema),
  asyncHandler(async (req, res) => {
    await authService.resetPassword(req.body.token, req.body.password);
    return ok(res, { reset: true }, 'Your password has been updated. Please sign in.');
  }),
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = await UserModel.findById(req.ctx.userId).lean();
    if (!user) throw ApiError.notFound('Account not found.');

    // One call gives the SPA everything it needs to render role-aware chrome.
    const payload: Record<string, unknown> = { ...publicUser(user) };

    if (user.role === 'photographer') {
      const profile = await PhotographerProfileModel.findOne({ userId: user._id }).lean();
      payload.photographerProfile = profile ?? null;
      payload.slug = profile?.slug ?? null;
    } else if (user.role === 'client') {
      const profile = await ClientProfileModel.findOne({ userId: user._id }).lean();
      payload.clientProfile = profile ?? null;
    }

    return ok(res, { user: payload });
  }),
);

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

router.post(
  '/change-password',
  authenticate,
  validateBody(changePasswordSchema),
  asyncHandler(async (req, res) => {
    await authService.changePassword(req.ctx.userId, req.body.currentPassword, req.body.newPassword);
    return ok(res, { changed: true }, 'Password updated. Please sign in again.');
  }),
);

const verifyEmailSchema = z.object({ token: z.string().min(10) });

router.post(
  '/verify-email',
  validateBody(verifyEmailSchema),
  asyncHandler(async (req, res) => {
    await authService.verifyEmail(req.body.token);
    return ok(res, { verified: true }, 'Email verified.');
  }),
);

export default router;
