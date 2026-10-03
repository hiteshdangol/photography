import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created, noContent } from '../utils/response.js';
import { GalleryShareModel } from '../models/index.js';
import { authenticate, optionalAuthenticate, requirePhotographer } from '../middleware/auth.js';
import { validateBody, validateQuery, q } from '../middleware/validate.js';
import { ApiError } from '../utils/ApiError.js';
import { AUDIT_ERRORS, SHARE_ERRORS } from '../messages.js';
import { assertProjectAccess, objectId } from '../services/authorization.js';
import { inspectShare, openSharedGallery } from '../services/shares.js';
import { randomToken, sha256 } from '../utils/crypto.js';
import type { RequestContext } from '../types/express.js';

const router = Router();

/* -------------------------------------------------------------------------- */
/* Managing links                                                               */
/* -------------------------------------------------------------------------- */

const byProjectSchema = z.object({ projectId: z.string().min(1) });

router.get(
  '/',
  authenticate,
  requirePhotographer,
  validateQuery(byProjectSchema),
  asyncHandler(async (req, res) => {
    const { projectId } = q<z.infer<typeof byProjectSchema>>(req);
    await assertProjectAccess(projectId, req.ctx);

    const shares = await GalleryShareModel.find({ projectId: objectId(projectId) })
      .sort({ active: -1, createdAt: -1 })
      .lean();

    return ok(res, { shares: shares.map((s) => toShareDto(s)) });
  }),
);

const createSchema = z.object({
  projectId: z.string().min(1),
  label: z.string().trim().max(120).optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  expiresInDays: z.number().int().min(1).max(365).nullable().optional(),
  maxAccesses: z.number().int().min(0).max(10_000).optional(),
});

/**
 * Mint a share link.
 *
 * Only a hash of the token is stored, so this response is the single time the raw
 * link exists on the server. If the caller loses it, they create a new link -
 * there is no recovery path, by design.
 */
router.post(
  '/',
  authenticate,
  requirePhotographer,
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const project = await assertProjectAccess(req.body.projectId, req.ctx);
    if (String(project.photographerId) !== String(req.ctx.tenantId)) {
      throw ApiError.forbidden('Only the owning photographer can share this gallery.');
    }
    if (!project.gallery.published) {
      throw ApiError.conflict('Publish the gallery before sharing it.');
    }

    const expiresAt =
      req.body.expiresAt ??
      (req.body.expiresInDays
        ? new Date(Date.now() + req.body.expiresInDays * 24 * 60 * 60 * 1000)
        : null);
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw ApiError.badRequest('Pick an expiry date in the future.');
    }

    const token = randomToken(32);
    const share = await GalleryShareModel.create({
      projectId: project._id,
      photographerId: project.photographerId,
      clientId: project.clientId,
      tokenHash: sha256(token),
      tokenHint: token.slice(0, 8),
      label: req.body.label ?? '',
      expiresAt,
      maxAccesses: req.body.maxAccesses ?? 0,
    });

    return created(
      res,
      {
        share: toShareDto(share.toObject()),
        // Shown once. The UI is expected to copy it immediately.
        url: `${req.protocol}://${req.get('host')}/g/${token}`,
      },
      'Gallery link created.',
    );
  }),
);

router.patch(
  '/:id',
  authenticate,
  requirePhotographer,
  validateBody(
    z.object({
      label: z.string().trim().max(120).optional(),
      expiresAt: z.coerce.date().nullable().optional(),
      maxAccesses: z.number().int().min(0).max(10_000).optional(),
      active: z.boolean().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const share = await assertShareOwnership(req.params.id, req.ctx);

    if (req.body.label !== undefined) share.label = req.body.label;
    if (req.body.expiresAt !== undefined) share.expiresAt = req.body.expiresAt;
    if (req.body.maxAccesses !== undefined) share.maxAccesses = req.body.maxAccesses;
    if (req.body.active !== undefined) {
      share.active = req.body.active;
      if (!req.body.active && !share.revokedAt) share.revokedAt = new Date();
    }

    await share.save();
    return ok(res, { share: toShareDto(share.toObject()) }, 'Link updated.');
  }),
);

router.post(
  '/:id/revoke',
  authenticate,
  requirePhotographer,
  asyncHandler(async (req, res) => {
    const share = await assertShareOwnership(req.params.id, req.ctx);
    if (!share.active) throw ApiError.conflict('That link is already revoked.');

    share.active = false;
    share.revokedAt = new Date();
    await share.save();
    return ok(res, { share: toShareDto(share.toObject()) }, 'Link revoked.');
  }),
);

router.delete(
  '/:id',
  authenticate,
  requirePhotographer,
  asyncHandler(async (req, res) => {
    const share = await assertShareOwnership(req.params.id, req.ctx);
    await share.deleteOne();
    return noContent(res, 'Link deleted.');
  }),
);

/* -------------------------------------------------------------------------- */
/* Resolving a link                                                            */
/* -------------------------------------------------------------------------- */

const resolveSchema = z.object({ token: z.string().min(20) });

/**
 * Turn a token into the gallery the visitor may browse.
 *
 * A live token is what grants access here, which is the whole point of a share
 * link: the person receiving it is frequently not the person who booked the
 * shoot, so requiring project membership would make most links useless. That is
 * also why every photo byte and metadata read re-checks the token server-side -
 * `viewer.role` is a hint for the UI, never an authorisation.
 *
 * The response says who is looking, so the client can prompt for sign-in on the
 * handful of actions that genuinely need an account (favouriting, downloads,
 * messaging) instead of hiding them behind a wall.
 */
router.get(
  '/resolve',
  optionalAuthenticate,
  validateQuery(resolveSchema),
  asyncHandler(async (req, res) => {
    const { token } = q<z.infer<typeof resolveSchema>>(req);

    // Validates, confirms the gallery is published, records one visit, and
    // returns a grant so the visitor can keep browsing past the access limit.
    const { project, share, viewToken } = await openSharedGallery(token, {
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] ?? ''),
    });

    const userId = req.ctx ? String(req.ctx.userId) : null;
    const isOwner = Boolean(userId) && String(share.photographerId) === userId;
    const isClient = Boolean(userId) && project.clientId && String(project.clientId) === userId;
    const isAdmin = req.ctx?.role === 'superadmin';

    const role = isOwner ? 'photographer' : isAdmin ? 'admin' : isClient ? 'client' : 'guest';

    return ok(res, {
      project: {
        id: String(project._id),
        title: project.title,
        slug: project.slug,
        eventDate: project.eventDate,
        status: project.status,
        coverPhotoId: project.coverPhotoId ? String(project.coverPhotoId) : null,
        counts: project.counts,
      },
      share: {
        id: String(share._id),
        label: share.label,
        expiresAt: share.expiresAt,
        maxAccesses: share.maxAccesses,
        accessCount: share.accessCount,
      },
      viewer: { role, signedIn: Boolean(req.ctx) },
      /**
       * Handed to the client and echoed back on photo reads. Without it a
       * visitor whose link has no remaining accesses would be locked out of the
       * gallery they are already looking at.
       */
      viewToken,
    });
  }),
);

/** Whether this link is still usable, without needing to be signed in. */
router.get(
  '/status',
  validateQuery(resolveSchema),
  asyncHandler(async (req, res) => {
    const { token } = q<z.infer<typeof resolveSchema>>(req);
    const { share, reason } = await inspectShare(token);
    if (!share) {
      return ok(res, { valid: false, reason: reason ?? AUDIT_ERRORS.shareRevoked });
    }
    return ok(res, {
      valid: true,
      label: share.label,
      expiresAt: share.expiresAt ?? null,
      remaining: share.maxAccesses > 0 ? Math.max(0, share.maxAccesses - share.accessCount) : null,
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

type ShareShape = {
  _id: unknown;
  projectId: unknown;
  label: string;
  active: boolean;
  tokenHint: string;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
  maxAccesses: number;
  accessCount: number;
  lastAccessedAt?: Date | null;
  firstAccessedAt?: Date | null;
  accessLog?: { at: Date; ip: string }[];
  createdAt: Date;
};

/** Never expose `tokenHash`: it is the only thing standing between a leak and access. */
function toShareDto(share: ShareShape) {
  const expired = share.expiresAt != null && share.expiresAt.getTime() < Date.now();
  return {
    id: String(share._id),
    projectId: String(share.projectId),
    label: share.label,
    tokenHint: share.tokenHint,
    active: share.active && !expired,
    expired,
    expiresAt: share.expiresAt,
    revokedAt: share.revokedAt,
    maxAccesses: share.maxAccesses,
    accessCount: share.accessCount,
    remaining: share.maxAccesses > 0 ? Math.max(0, share.maxAccesses - share.accessCount) : null,
    firstAccessedAt: share.firstAccessedAt,
    lastAccessedAt: share.lastAccessedAt,
    createdAt: share.createdAt,
    // Trimmed to the last 50 visits: enough for "who shared this", not a surveillance log.
    recentAccesses: (share.accessLog ?? []).slice(-50),
  };
}

async function assertShareOwnership(id: string, ctx: RequestContext) {
  const share = await GalleryShareModel.findById(objectId(id, 'share id'));
  if (!share) throw ApiError.notFound(SHARE_ERRORS.notFound);
  if (String(share.photographerId) !== String(ctx.tenantId)) {
    throw ApiError.forbidden('That link belongs to another studio.');
  }
  return share;
}



export default router;
