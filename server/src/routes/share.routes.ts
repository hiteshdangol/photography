import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created, noContent } from '../utils/response.js';
import { GalleryShareModel, ProjectModel } from '../models/index.js';
import { authenticate, requirePhotographer } from '../middleware/auth.js';
import { validateBody, validateQuery, q } from '../middleware/validate.js';
import { ApiError } from '../utils/ApiError.js';
import { AUDIT_ERRORS, SHARE_ERRORS } from '../messages.js';
import { assertProjectAccess, objectId } from '../services/authorization.js';
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
 * The token is checked for liveness only. Whether the caller may *see* the
 * photos is decided by `optionalAuthenticate` plus the project membership check
 * below, so an intercepted link cannot be used to view someone else's gallery.
 */
router.get(
  '/resolve',
  authenticate,
  validateQuery(resolveSchema),
  asyncHandler(async (req, res) => {
    const { token } = q<z.infer<typeof resolveSchema>>(req);
    const share = await findLiveShare(token);
    if (!share) throw ApiError.forbidden(AUDIT_ERRORS.shareRevoked);

    const project = await ProjectModel.findById(share.projectId)
      .select('title slug status eventDate gallery photographerId clientId counts')
      .lean();

    if (!project || !project.gallery?.published) {
      throw ApiError.notFound(AUDIT_ERRORS.noGallery);
    }

    const isOwner = String(share.photographerId) === String(req.ctx.userId);
    const isClient = project.clientId && String(project.clientId) === String(req.ctx.userId);
    const isAdmin = req.ctx.role === 'superadmin';

    if (!isOwner && !isClient && !isAdmin) {
      throw ApiError.forbidden(AUDIT_ERRORS.notParticipant);
    }

    // An authenticated, permitted visit is the thing worth counting, so it is
    // recorded here rather than on every rendition fetch.
    await recordVisit(share, req);

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
        accessCount: share.accessCount + 1,
      },
      viewer: { role: isOwner ? 'photographer' : isAdmin ? 'admin' : 'client' },
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

/**
 * Resolve a raw token to a share that is still usable, or `null`.
 *
 * Access limits and expiry are enforced on read, so a link that ran out of
 * accesses stops working immediately rather than at the next cron sweep.
 */
async function inspectShare(token: string) {
  const share = await GalleryShareModel.findOne({ tokenHash: sha256(token) });
  if (!share || !share.active || share.revokedAt) {
    return { share: null, reason: AUDIT_ERRORS.shareRevoked as string };
  }
  if (share.expiresAt && share.expiresAt.getTime() < Date.now()) {
    return { share: null, reason: AUDIT_ERRORS.shareExpired as string };
  }
  if (share.maxAccesses > 0 && share.accessCount >= share.maxAccesses) {
    return { share: null, reason: SHARE_ERRORS.limitReached as string };
  }
  return { share, reason: undefined };
}

async function findLiveShare(token: string) {
  const { share, reason } = await inspectShare(token);
  if (!share) throw ApiError.forbidden(reason ?? AUDIT_ERRORS.shareRevoked);
  return share;
}

async function recordVisit(
  share: { _id: unknown; accessCount: number; firstAccessedAt?: Date | null },
  req: { ip?: string; headers: Record<string, unknown> },
): Promise<void> {
  await GalleryShareModel.updateOne(
    { _id: share._id },
    {
      $inc: { accessCount: 1 },
      $set: { lastAccessedAt: new Date(), ...(share.firstAccessedAt ? {} : { firstAccessedAt: new Date() }) },
      $push: {
        accessLog: {
          $each: [
            {
              at: new Date(),
              ip: req.ip ?? '',
              userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
            },
          ],
          $slice: -200,
        },
      },
    },
  );
}

export default router;
