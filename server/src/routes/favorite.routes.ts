import { Router } from 'express';
import { z } from 'zod';
import type { Types } from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, noContent } from '../utils/response.js';
import { FavoriteModel, PhotoModel } from '../models/index.js';
import { authenticate, requireClient } from '../middleware/auth.js';
import { validateBody, validateQuery, q } from '../middleware/validate.js';
import { ApiError } from '../utils/ApiError.js';
import { assertProjectAccess, objectId } from '../services/authorization.js';
import { refreshPhotoCounts, refreshProjectCounts } from '../services/counts.js';

const router = Router();

const listSchema = z.object({
  projectId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/**
 * The client's favourites.
 *
 * Favouriting is a private, per-client thing: the photographer sees the *count* on
 * a photo but never which client liked it, so this list is client-only.
 */
router.get(
  '/',
  authenticate,
  requireClient,
  validateQuery(listSchema),
  asyncHandler(async (req, res) => {
    const filters = q<z.infer<typeof listSchema>>(req);
    const filter: Record<string, unknown> = { clientId: req.ctx.userId };
    if (filters.projectId) filter.projectId = objectId(filters.projectId, 'project id');

    const favorites = await FavoriteModel.find(filter)
      .sort({ createdAt: -1 })
      .limit(filters.limit)
      .lean();

    const photoIds = favorites.map((f) => f.photoId);
    const photos = await PhotoModel.find({ _id: { $in: photoIds } }).select('projectId isHighlight').lean();
    const highlightByPhoto = new Set(
      photos.filter((p) => p.isHighlight).map((p) => String(p._id)),
    );

    return ok(res, {
      favorites: favorites.map((f) => ({
        photoId: String(f.photoId),
        projectId: String(f.projectId),
        isHighlight: highlightByPhoto.has(String(f.photoId)),
        favoritedAt: f.createdAt,
      })),
      count: favorites.length,
    });
  }),
);

const favoriteSchema = z.object({
  photoIds: z.array(z.string()).min(1, 'Pick at least one photo.').max(500),
});

/**
 * Favourite a batch. Idempotent by design: the unique index on (client, photo)
 * turns a repeated call into a no-op rather than a duplicate error, so a
 * double-click or a retried request is harmless.
 */
router.post(
  '/',
  authenticate,
  requireClient,
  validateBody(favoriteSchema),
  asyncHandler(async (req, res) => {
    const photoIds = (req.body.photoIds as string[]).map((id) => objectId(id, 'photo id'));
    const uniqueIds = [...new Set(photoIds.map(String))];

    const photos = await PhotoModel.find({ _id: { $in: photoIds }, clientId: req.ctx.userId })
      .select('_id projectId photographerId')
      .lean();

    if (photos.length !== uniqueIds.length) {
      throw ApiError.badRequest('One or more photos are not in your gallery.');
    }

    const operations = photos.map((photo) => ({
      updateOne: {
        filter: { clientId: req.ctx.userId, photoId: photo._id },
        update: { $setOnInsert: { projectId: photo.projectId, photographerId: photo.photographerId } },
        upsert: true,
      },
    }));
    const result = await FavoriteModel.bulkWrite(operations, { ordered: false });
    const added = result.upsertedCount ?? 0;

    if (added > 0) {
      // Recount rather than `$inc`: a partial batch would otherwise add the total
      // new count to every photo in the batch, including the ones already saved.
      await Promise.all(photos.map((photo) => refreshPhotoCounts(photo._id)));
      await refreshProjects(photos.map((p) => p.projectId));
    }

    return ok(res, { added, total: uniqueIds.length }, added > 0 ? 'Added to favourites.' : 'Already in favourites.');
  }),
);

const unfavoriteSchema = z.object({
  photoIds: z.array(z.string()).min(1).max(500),
});

router.delete(
  '/',
  authenticate,
  requireClient,
  validateBody(unfavoriteSchema),
  asyncHandler(async (req, res) => {
    const photoIds = (req.body.photoIds as string[]).map((id) => objectId(id, 'photo id'));
    const favorites = await FavoriteModel.find({
      clientId: req.ctx.userId,
      photoId: { $in: photoIds },
    })
      .select('photoId projectId')
      .lean();

    if (favorites.length === 0) return ok(res, { removed: 0 }, 'Nothing to remove.');

    await FavoriteModel.deleteMany({ clientId: req.ctx.userId, photoId: { $in: photoIds } });
    await Promise.all(favorites.map((f) => refreshPhotoCounts(f.photoId)));
    await refreshProjects(favorites.map((f) => f.projectId));

    return noContent(res, `${favorites.length} removed from favourites.`);
  }),
);

/** Toggle a single photo, which is what the heart button calls. */
router.post(
  '/toggle',
  authenticate,
  requireClient,
  validateBody(z.object({ photoId: z.string().min(1) })),
  asyncHandler(async (req, res) => {
    const photoId = objectId(req.body.photoId, 'photo id');
    const photo = await PhotoModel.findById(photoId).select('_id clientId projectId photographerId').lean();
    if (!photo || String(photo.clientId) !== String(req.ctx.userId)) {
      throw ApiError.notFound('That photo is not in your gallery.');
    }

    const existing = await FavoriteModel.findOne({ clientId: req.ctx.userId, photoId }).select('_id').lean();
    if (existing) {
      await FavoriteModel.deleteOne({ _id: existing._id });
      await refreshPhotoCounts(photoId);
      await refreshProjects([photo.projectId]);
      return ok(res, { favorited: false }, 'Removed from favourites.');
    }

    await FavoriteModel.create({
      clientId: req.ctx.userId,
      photoId,
      projectId: photo.projectId,
      photographerId: photo.photographerId,
    });
    await refreshPhotoCounts(photoId);
    await refreshProjects([photo.projectId]);

    return ok(res, { favorited: true }, 'Added to favourites.');
  }),
);

/**
 * The photographer's view: how many favourites each photo has. Per client, never
 * per client identity - useful for curation, not for surveillance.
 */
const countsSchema = z.object({ projectId: z.string().min(1) });

router.get(
  '/counts',
  authenticate,
  validateQuery(countsSchema),
  asyncHandler(async (req, res) => {
    const { projectId } = q<z.infer<typeof countsSchema>>(req);
    await assertProjectAccess(projectId, req.ctx);

    const counts = await FavoriteModel.aggregate([
      { $match: { projectId: objectId(projectId) } },
      { $group: { _id: '$photoId', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 200 },
    ]);

    return ok(res, {
      counts: counts.map((c) => ({ photoId: String(c._id), count: c.count })),
    });
  }),
);

/** Recount the touched projects, de-duplicated so a shared project is done once. */
async function refreshProjects(projectIds: Types.ObjectId[]): Promise<void> {
  const seen = new Set<string>();
  for (const projectId of projectIds) {
    const key = String(projectId);
    if (seen.has(key)) continue;
    seen.add(key);
    await refreshProjectCounts(projectId);
  }
}

export default router;
