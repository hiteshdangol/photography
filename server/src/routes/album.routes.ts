import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created, noContent } from '../utils/response.js';
import { AlbumModel, PhotoModel, PhotoSelectionModel } from '../models/index.js';
import { authenticate, requirePhotographer } from '../middleware/auth.js';
import { validateBody, validateQuery, q } from '../middleware/validate.js';
import { ApiError } from '../utils/ApiError.js';
import { assertAlbumAccess, assertProjectAccess, objectId } from '../services/authorization.js';
import { refreshProjectCounts } from '../services/counts.js';
import { notify } from '../services/notifications/dispatcher.js';

const router = Router();

const listSchema = z.object({
  projectId: z.string().optional(),
  status: z.enum(['draft', 'selection_open', 'selection_complete', 'final']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(60).default(24),
});

router.get(
  '/',
  authenticate,
  validateQuery(listSchema),
  asyncHandler(async (req, res) => {
    const filters = q<z.infer<typeof listSchema>>(req);
    const pagination = {
      page: filters.page,
      limit: filters.limit,
      skip: (filters.page - 1) * filters.limit,
    };

    const filter: Record<string, unknown> =
      req.ctx.role === 'client' ? { clientId: req.ctx.userId } : { photographerId: req.ctx.tenantId };
    if (req.ctx.role === 'superadmin') delete filter.photographerId;
    if (filters.projectId) filter.projectId = objectId(filters.projectId, 'project id');
    if (filters.status) filter.status = filters.status;

    // A client only ever sees published albums.
    if (req.ctx.role === 'client') filter.published = true;

    const [items, total] = await Promise.all([
      AlbumModel.find(filter)
        .sort({ sortOrder: 1, createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit)
        .lean(),
      AlbumModel.countDocuments(filter),
    ]);

    return ok(res, {
      albums: items,
      pagination: {
        ...pagination,
        total,
        totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
      },
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Photographer management                                                      */
/* -------------------------------------------------------------------------- */

const createSchema = z.object({
  projectId: z.string().min(1, 'A project is required.'),
  name: z.string().trim().min(2, 'Give the album a name.').max(120),
  description: z.string().trim().max(1000).optional(),
  selectionLimit: z.number().int().min(0).nullable().optional(),
  selectionDueAt: z.coerce.date().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

router.post(
  '/',
  authenticate,
  requirePhotographer,
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const project = await assertProjectAccess(req.body.projectId, req.ctx);
    if (String(project.photographerId) !== String(req.ctx.tenantId)) {
      throw ApiError.forbidden('Only the owning photographer can create an album.');
    }

    const album = await AlbumModel.create({
      projectId: project._id,
      photographerId: project.photographerId,
      clientId: project.clientId,
      name: req.body.name,
      description: req.body.description ?? '',
      selectionLimit: req.body.selectionLimit ?? null,
      selectionDueAt: req.body.selectionDueAt ?? null,
      sortOrder: req.body.sortOrder ?? 0,
      status: 'draft',
    });

    await refreshProjectCounts(project._id);
    return created(res, { album }, 'Album created.');
  }),
);

const updateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(1000).optional(),
  selectionLimit: z.number().int().min(0).nullable().optional(),
  selectionDueAt: z.coerce.date().nullable().optional(),
  coverPhotoId: z.string().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

router.patch(
  '/:id',
  authenticate,
  requirePhotographer,
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    const album = await assertAlbumAccess(req.params.id, req.ctx);
    if (String(album.photographerId) !== String(req.ctx.tenantId)) {
      throw ApiError.forbidden('Only the owning photographer can edit an album.');
    }

    if (req.body.coverPhotoId) {
      const cover = await PhotoModel.findOne({
        _id: objectId(req.body.coverPhotoId),
        albumId: album._id,
      })
        .select('_id')
        .lean();
      if (!cover) throw ApiError.badRequest('That photo is not in this album.');
      album.coverPhotoId = cover._id;
    }

    if (req.body.name !== undefined) album.name = req.body.name;
    if (req.body.description !== undefined) album.description = req.body.description;
    if (req.body.sortOrder !== undefined) album.sortOrder = req.body.sortOrder;
    if (req.body.selectionDueAt !== undefined) album.selectionDueAt = req.body.selectionDueAt;

    // Lowering the limit below what the client already picked would silently
    // invalidate their submission, so it is refused with an explanation.
    if (req.body.selectionLimit !== undefined) {
      const current = await PhotoSelectionModel.countDocuments({ albumId: album._id });
      if (req.body.selectionLimit !== null && current > req.body.selectionLimit) {
        throw ApiError.conflict(
          `Your client has already selected ${current} photos. Remove some before lowering the limit to ${req.body.selectionLimit}.`,
        );
      }
      album.selectionLimit = req.body.selectionLimit;
    }

    await album.save();
    return ok(res, { album }, 'Album updated.');
  }),
);

/** Open the album for the client to choose their photos. */
router.post(
  '/:id/publish',
  authenticate,
  requirePhotographer,
  asyncHandler(async (req, res) => {
    const album = await assertAlbumAccess(req.params.id, req.ctx);
    if (String(album.photographerId) !== String(req.ctx.tenantId)) {
      throw ApiError.forbidden('Only the owning photographer can publish an album.');
    }

    const photos = await PhotoModel.countDocuments({ albumId: album._id });
    if (photos === 0) throw ApiError.badRequest('Add photos to the album before publishing it.');

    album.published = true;
    album.publishedAt = new Date();
    album.status = 'selection_open';
    album.selectionOpenAt = new Date();
    album.counts.photos = photos;
    await album.save();

    await notify({
      userId: album.clientId,
      photographerId: album.photographerId,
      projectId: album.projectId,
      type: 'album_published',
      title: 'Your album is ready',
      message: `${album.name} is ready for you to choose your favourite photos.`,
      link: `/projects/${String(album.projectId)}/album-selection`,
      priority: 'high',
      email: true,
    });

    return ok(res, { album }, 'Album published.');
  }),
);

router.post(
  '/:id/close-selection',
  authenticate,
  requirePhotographer,
  asyncHandler(async (req, res) => {
    const album = await assertAlbumAccess(req.params.id, req.ctx);
    if (String(album.photographerId) !== String(req.ctx.tenantId)) {
      throw ApiError.forbidden('Only the owning photographer can close selection.');
    }
    if (album.status !== 'selection_open') {
      throw ApiError.conflict('This album is not currently open for selection.');
    }

    // Closing is a manual override, so the timeline still gets one forward step.
    album.status = 'selection_complete';
    album.selectionCompletedAt = new Date();
    await album.save();
    return ok(res, { album }, 'Selection closed.');
  }),
);

/**
 * Album detail. Reached through `assertAlbumAccess`, so a client can only open an
 * album on their own project - and an unpublished album is invisible to them.
 */
router.get(
  '/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    const album = await assertAlbumAccess(req.params.id, req.ctx);
    if (req.ctx.role === 'client' && !album.published) {
      throw ApiError.notFound('That album does not exist.');
    }

    const photos = await PhotoModel.find({ albumId: album._id }).sort({ sortOrder: 1 }).limit(500).lean();
    return ok(res, {
      album,
      photos: photos.map((p) => ({
        id: String(p._id),
        width: p.width,
        height: p.height,
        aspectRatio: p.aspectRatio,
        blurDataUrl: p.blurDataUrl,
        url: `/api/photos/${String(p._id)}/file?variant=thumbnail`,
        fullUrl: `/api/photos/${String(p._id)}/file?variant=gallery`,
      })),
    });
  }),
);

router.delete(
  '/:id',
  authenticate,
  requirePhotographer,
  asyncHandler(async (req, res) => {
    const album = await assertAlbumAccess(req.params.id, req.ctx);
    if (String(album.photographerId) !== String(req.ctx.tenantId)) {
      throw ApiError.forbidden('Only the owning photographer can delete an album.');
    }
    await album.deleteOne();
    await PhotoSelectionModel.deleteMany({ albumId: album._id });
    await PhotoModel.updateMany({ albumId: album._id }, { $set: { albumId: null } });
    await refreshProjectCounts(album.projectId);
    return noContent(res, 'Album deleted.');
  }),
);

export default router;
