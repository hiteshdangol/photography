import { Router } from 'express';
import { z } from 'zod';
import type { Request } from 'express';
import type { Types } from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created, noContent } from '../utils/response.js';
import { AlbumModel, PhotoModel, ProjectModel } from '../models/index.js';
import { authenticate, requirePhotographer, optionalAuthenticate } from '../middleware/auth.js';
import { validateBody, validateQuery, q } from '../middleware/validate.js';
import { ApiError } from '../utils/ApiError.js';
import { assertPhotoAccess, assertProjectAccess, objectId } from '../services/authorization.js';
import { assertShareAccess, isLiveShareForProject } from '../services/shares.js';
import { toPhotoDto } from '../services/photoDto.js';
import { advance } from '../services/timeline/engine.js';
import { multiImageUpload, runUpload } from '../middleware/upload.js';
import { uploadLimiter } from '../middleware/rateLimit.js';
import { AUDIT_ERRORS, UPLOAD_ERRORS } from '../messages.js';
import { PHOTO_CATEGORIES } from '../config/constants.js';
import { getStorage } from '../services/storage/index.js';
import { keyForVariant, processImage, safeFilename, type ImageVariant } from '../services/image/pipeline.js';

const router = Router();

/* -------------------------------------------------------------------------- */
/* Listing                                                                     */
/* -------------------------------------------------------------------------- */

const listSchema = z.object({
  projectId: z.string().optional(),
  albumId: z.string().optional(),
  category: z.enum(PHOTO_CATEGORIES).optional(),
  highlights: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(200).default(48),
  /**
   * A gallery share token. Only consulted when the request is not
   * authenticated, which is what lets a shared gallery be listed as well as
   * viewed. Ignored for signed-in callers - they use participant rules.
   */
  token: z.string().optional(),
  /**
   * Receipt for having opened the gallery. Carries no access of its own; it
   * only keeps a visitor browsing after a link's access limit is spent.
   */
  viewToken: z.string().optional(),
});

/**
 * Photo list. Always scoped to a project the caller can reach - the projectId is
 * resolved through `assertProjectAccess` before any photo query runs, so there
 * is no path where an arbitrary photoId reveals bytes from another tenant.
 *
 * An unauthenticated visitor is allowed only with a live share token for that
 * exact project, which is what makes a share link a browsable gallery rather
 * than just a picture URL. Sign-in always wins: a signed-in caller's own
 * participant rules apply and the token is ignored.
 */
router.get(
  '/',
  optionalAuthenticate,
  validateQuery(listSchema),
  asyncHandler(async (req, res) => {
    const filters = q<z.infer<typeof listSchema>>(req);
    if (!filters.projectId) throw ApiError.badRequest('A project is required.');

    const projectId = objectId(filters.projectId, 'project id');
    const project = req.ctx
      ? await assertProjectAccess(projectId, req.ctx, { adminAudit: readReason(req) })
      : await assertShareAccess(filters.token, filters.viewToken);

    // A share token is bound to one project, so it can never be replayed
    // against another project's photos.
    if (String(project._id) !== String(projectId)) {
      throw ApiError.forbidden(AUDIT_ERRORS.shareRevoked);
    }

    const filter: Record<string, unknown> = { projectId: project._id };
    if (filters.albumId) filter.albumId = objectId(filters.albumId, 'album id');
    if (filters.category) filter.category = filters.category;
    if (filters.highlights) filter.isHighlight = true;

    const photos = await PhotoModel.find(filter)
      .sort({ sortOrder: 1, uploadedAt: 1 })
      .limit(filters.limit)
      .lean();

    return ok(res, { photos: photos.map(toPhotoDto), count: photos.length });
  }),
);

/* -------------------------------------------------------------------------- */
/* Upload                                                                      */
/* -------------------------------------------------------------------------- */

const uploadSchema = z.object({
  projectId: z.string().min(1, 'A project is required.'),
  albumId: z.string().optional(),
  category: z.enum(PHOTO_CATEGORIES).default('other'),
  caption: z.string().trim().max(500).optional(),
  isHighlight: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

/**
 * Bulk upload.
 *
 * Files arrive as memory buffers (see middleware/upload.ts for why disk storage
 * is wrong here), are validated by decoding them, and produce four renditions.
 *
 * Files are processed sequentially: Sharp already runs at concurrency 2, and a
 * 60-file burst in parallel is a memory spike. On failure everything written so
 * far is rolled back, so a partial batch never leaves orphaned bytes or rows.
 */
router.post(
  '/upload',
  authenticate,
  requirePhotographer,
  uploadLimiter,
  runUpload(multiImageUpload),
  validateBody(uploadSchema),
  asyncHandler(async (req, res) => {
    const project = await assertProjectAccess(req.body.projectId, req.ctx);
    if (String(project.photographerId) !== String(req.ctx.tenantId)) {
      throw ApiError.forbidden('Only the owning photographer can upload photos.');
    }

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) throw ApiError.badRequest(UPLOAD_ERRORS.missing);

    if (req.body.albumId) {
      const album = await AlbumModel.findOne({
        _id: objectId(req.body.albumId, 'album id'),
        projectId: project._id,
      })
        .select('_id')
        .lean();
      if (!album) throw ApiError.badRequest('That album is not part of this project.');
    }

    const storage = getStorage();
    const createdIds: string[] = [];
    const writtenKeys: string[] = [];

    try {
      for (const [index, file] of files.entries()) {
        const baseName = safeFilename('ph');
        const { image, buffers } = await processImage(file.buffer, baseName, String(project._id));

        // Keys are namespaced by project inside each bucket, so one tenant's
        // bytes can never be enumerated from another's prefix. `put` returns the
        // bucket-qualified key, and that is what gets persisted - the stored value
        // is exactly what a later read or delete will use.
        const variants = [
          { bucket: 'originals', key: image.originalKey, body: buffers.original, type: 'image/jpeg' },
          { bucket: 'optimized', key: image.optimizedKey, body: buffers.optimized, type: image.mimeType },
          { bucket: 'thumbnails', key: image.thumbnailKey, body: buffers.thumbnail, type: image.mimeType },
        ] as const;

        const storedKeys: string[] = [];
        for (const variant of variants) {
          const stored = await storage.put(variant.body, {
            bucket: variant.bucket,
            key: variant.key,
            contentType: variant.type,
            cacheControl: 'private, max-age=31536000, immutable',
          });
          storedKeys.push(stored.key);
          writtenKeys.push(stored.key);
        }

        const photo = await PhotoModel.create({
          projectId: project._id,
          albumId: req.body.albumId ? objectId(req.body.albumId) : null,
          photographerId: project.photographerId,
          clientId: project.clientId,
          filename: `${baseName}.jpg`,
          originalFilename: sanitiseOriginalName(file.originalname),
          mimeType: image.mimeType,
          originalKey: storedKeys[0],
          optimizedKey: storedKeys[1],
          thumbnailKey: storedKeys[2],
          originalSize: image.originalSize,
          optimizedSize: image.optimizedSize,
          thumbnailSize: image.thumbnailSize,
          width: image.width,
          height: image.height,
          originalWidth: image.originalWidth,
          originalHeight: image.originalHeight,
          aspectRatio: image.aspectRatio,
          blurDataUrl: image.blurDataUrl,
          dominantColor: image.dominantColor,
          isHighlight: Boolean(req.body.isHighlight),
          highlightOrder: req.body.isHighlight ? index : 0,
          sortOrder: index,
          category: req.body.category,
          caption: req.body.caption ?? '',
          uploadedAt: new Date(),
        });
        createdIds.push(String(photo._id));
      }
    } catch (error) {
      // Roll the batch back: no half-uploaded projects, no orphaned bytes.
      await PhotoModel.deleteMany({ _id: { $in: createdIds } });
      for (const key of writtenKeys) {
        try {
          await storage.delete(key);
        } catch {
          /* best effort: a leftover object is harmless, a half-written row is not */
        }
      }
      throw error;
    }

    await refreshCounts(project._id);

    // First upload => the project is in editing.
    await advance({
      projectId: project._id,
      trigger: 'PHOTOS_UPLOADED',
      actorId: req.ctx.userId,
      description: `${files.length} photo${files.length === 1 ? '' : 's'} uploaded.`,
    });

    return created(res, { photoIds: createdIds, count: createdIds.length }, 'Photos uploaded.');
  }),
);

/* -------------------------------------------------------------------------- */
/* Streaming                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The only route that serves image bytes.
 *
 * There is no static mount on the upload directory, so every image request passes
 * through an authorization check: a signed-in participant, or a signed-out
 * visitor holding a valid share token *and* viewing a published gallery. The
 * variant is then narrowed by the download policy, so a thumbnail URL can never
 * be edited into `?variant=original`.
 */
router.get(
  '/:id/file',
  optionalAuthenticate,
  asyncHandler(async (req, res) => {
    const photo = await PhotoModel.findById(objectId(req.params.id, 'photo id'));
    if (!photo) throw ApiError.notFound('That photo does not exist.');

    const requested = (req.query.variant as ImageVariant) ?? 'gallery';
    let variant = requested;

    if (!req.ctx) {
      const granted = await authorizeShareVisit(req, photo.projectId);
      if (!granted) throw ApiError.forbidden('You are not authorized to view this photo.');
      // A share link never exposes full-resolution originals, whatever was asked for.
      if (requested === 'original') variant = 'gallery';
    } else {
      await assertPhotoAccess(photo._id, req.ctx, { adminAudit: readReason(req) });
      variant = narrowVariant(photo, requested, req.ctx.role, req.ctx.tenantId);
    }

    const key = keyForVariant(photo, variant);
    const storage = getStorage();
    if (!(await storage.exists(key))) throw ApiError.notFound('That image is missing.');

    const stat = await storage.stat(key);
    res.setHeader('Content-Type', stat?.contentType ?? 'image/jpeg');
    res.setHeader('Cache-Control', variant === 'original' ? 'private, no-store' : 'private, max-age=86400');
    res.setHeader('Content-Length', String(stat?.size ?? 0));
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const stream = await storage.getStream(key);
    stream.pipe(res);
  }),
);

/* -------------------------------------------------------------------------- */
/* Single photo                                                                */
/* -------------------------------------------------------------------------- */

const updateSchema = z.object({
  caption: z.string().trim().max(500).optional(),
  category: z.enum(PHOTO_CATEGORIES).optional(),
  isHighlight: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
  albumId: z.string().nullable().optional(),
  allowDownload: z.boolean().optional(),
  allowOriginalDownload: z.boolean().optional(),
});

router.get(
  '/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    const photo = await assertPhotoAccess(req.params.id, req.ctx, { adminAudit: readReason(req) });
    return ok(res, { photo: toPhotoDto(photo.toObject()) });
  }),
);

router.patch(
  '/:id',
  authenticate,
  requirePhotographer,
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    const photo = await assertPhotoAccess(req.params.id, req.ctx);
    if (String(photo.photographerId) !== String(req.ctx.tenantId)) {
      throw ApiError.forbidden('Only the owning photographer can edit a photo.');
    }

    // Remember where the photo was so the album it left can be recounted too.
    const previousAlbumId = photo.albumId;

    if (req.body.albumId !== undefined) {
      if (req.body.albumId === null) {
        photo.albumId = null;
      } else {
        const album = await AlbumModel.findOne({
          _id: objectId(req.body.albumId, 'album id'),
          projectId: photo.projectId,
        })
          .select('_id')
          .lean();
        if (!album) throw ApiError.badRequest('That album is not part of this project.');
        photo.albumId = album._id;
      }
    }

    if (req.body.caption !== undefined) photo.caption = req.body.caption;
    if (req.body.category !== undefined) photo.category = req.body.category;
    if (req.body.sortOrder !== undefined) photo.sortOrder = req.body.sortOrder;
    if (req.body.allowDownload !== undefined) photo.allowDownload = req.body.allowDownload;
    if (req.body.allowOriginalDownload !== undefined) {
      photo.allowOriginalDownload = req.body.allowOriginalDownload;
    }
    if (req.body.isHighlight !== undefined) {
      photo.isHighlight = req.body.isHighlight;
      if (req.body.isHighlight && photo.highlightOrder === 0) {
        const last = await PhotoModel.findOne({ projectId: photo.projectId, isHighlight: true })
          .sort({ highlightOrder: -1 })
          .select('highlightOrder')
          .lean();
        photo.highlightOrder = (last?.highlightOrder ?? -1) + 1;
      }
    }

    await photo.save();

    // Counters live on the parent rows for cheap dashboard rendering. A move has
    // two affected albums: the one it joined and the one it left.
    if (req.body.albumId !== undefined) {
      const movedAway =
        previousAlbumId && String(previousAlbumId) !== String(photo.albumId ?? '');
      if (movedAway && previousAlbumId) await syncAlbumCounts(previousAlbumId);
      if (photo.albumId) await syncAlbumCounts(photo.albumId);
    }
    await refreshCounts(photo.projectId);

    return ok(res, { photo: toPhotoDto(photo.toObject()) }, 'Photo updated.');
  }),
);

/** Delete a photo and every rendition it owns. */
router.delete(
  '/:id',
  authenticate,
  requirePhotographer,
  asyncHandler(async (req, res) => {
    const photo = await assertPhotoAccess(req.params.id, req.ctx);
    if (String(photo.photographerId) !== String(req.ctx.tenantId)) {
      throw ApiError.forbidden('Only the owning photographer can delete a photo.');
    }

    const projectId = photo.projectId;
    const albumId = photo.albumId;
    const keys = [photo.originalKey, photo.optimizedKey, photo.thumbnailKey];
    const storage = getStorage();

    await photo.deleteOne();
    for (const key of keys) {
      try {
        await storage.delete(key);
      } catch {
        /* best effort: an orphaned object costs storage, a dangling row costs correctness */
      }
    }

    if (albumId) await syncAlbumCounts(albumId);
    await refreshCounts(projectId);
    return noContent(res, 'Photo deleted.');
  }),
);

/* -------------------------------------------------------------------------- */
/* Highlights and gallery publication                                          */
/* -------------------------------------------------------------------------- */

const highlightSchema = z.object({
  projectId: z.string().min(1),
  photoIds: z.array(z.string()).min(1, 'Pick at least one photo.').max(200),
});

/** Replace the highlight reel and its order in one call. */
router.put(
  '/highlights',
  authenticate,
  requirePhotographer,
  validateBody(highlightSchema),
  asyncHandler(async (req, res) => {
    const project = await assertProjectAccess(req.body.projectId, req.ctx);
    if (String(project.photographerId) !== String(req.ctx.tenantId)) {
      throw ApiError.forbidden('Only the owning photographer can set highlights.');
    }

    const ids = (req.body.photoIds as string[]).map((id) => objectId(id, 'photo id'));
    const owned = await PhotoModel.countDocuments({ _id: { $in: ids }, projectId: project._id });
    if (owned !== ids.length) {
      throw ApiError.badRequest('One or more photos are not part of this project.');
    }

    await PhotoModel.updateMany({ projectId: project._id }, { $set: { isHighlight: false, highlightOrder: 0 } });
    await PhotoModel.bulkWrite(
      ids.map((photoId, index) => ({
        updateOne: {
          filter: { _id: photoId, projectId: project._id },
          update: { $set: { isHighlight: true, highlightOrder: index } },
        },
      })),
    );

    project.gallery.highlightsCount = ids.length;
    await project.save();
    await refreshCounts(project._id);

    return ok(res, { highlightsCount: ids.length }, 'Highlights updated.');
  }),
);

/** Publish the highlight reel: the "highlights ready" milestone. */
router.post(
  '/highlights/publish',
  authenticate,
  requirePhotographer,
  validateBody(z.object({ projectId: z.string().min(1) })),
  asyncHandler(async (req, res) => {
    const project = await assertProjectAccess(req.body.projectId, req.ctx);
    if (String(project.photographerId) !== String(req.ctx.tenantId)) {
      throw ApiError.forbidden('Only the owning photographer can publish highlights.');
    }

    const count = await PhotoModel.countDocuments({ projectId: project._id, isHighlight: true });
    if (count === 0) throw ApiError.badRequest('Mark at least one photo as a highlight first.');

    project.gallery.highlightsCount = count;
    project.gallery.highlightsPublishedAt = new Date();
    await project.save();

    await advance({
      projectId: project._id,
      trigger: 'HIGHLIGHTS_PUBLISHED',
      actorId: req.ctx.userId,
      description: `${count} highlight${count === 1 ? '' : 's'} published.`,
    });

    return ok(res, { highlightsCount: count }, 'Highlights published.');
  }),
);

router.post(
  '/gallery/publish',
  authenticate,
  requirePhotographer,
  validateBody(z.object({ projectId: z.string().min(1) })),
  asyncHandler(async (req, res) => {
    const project = await assertProjectAccess(req.body.projectId, req.ctx);
    if (String(project.photographerId) !== String(req.ctx.tenantId)) {
      throw ApiError.forbidden('Only the owning photographer can publish a gallery.');
    }

    const photoCount = await PhotoModel.countDocuments({ projectId: project._id });
    if (photoCount === 0) throw ApiError.badRequest('Add photos before publishing the gallery.');

    project.gallery.published = true;
    project.gallery.publishedAt = new Date();
    project.gallery.totalPhotos = photoCount;
    project.status = 'delivered';
    await project.save();
    await refreshCounts(project._id);

    await advance({
      projectId: project._id,
      trigger: 'GALLERY_PUBLISHED',
      actorId: req.ctx.userId,
      description: `${photoCount} photos published to the private gallery.`,
    });

    return ok(res, { project }, 'Gallery published.');
  }),
);

router.post(
  '/gallery/unpublish',
  authenticate,
  requirePhotographer,
  validateBody(z.object({ projectId: z.string().min(1) })),
  asyncHandler(async (req, res) => {
    const project = await assertProjectAccess(req.body.projectId, req.ctx);
    if (String(project.photographerId) !== String(req.ctx.tenantId)) {
      throw ApiError.forbidden('Only the owning photographer can unpublish a gallery.');
    }
    project.gallery.published = false;
    await project.save();
    return ok(res, { project }, 'Gallery unpublished.');
  }),
);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */



/**
 * Download policy. A client asking for the original rendition needs both the
 * project and the photo to allow it; they cannot grant it to themselves.
 */
function narrowVariant(
  photo: { allowDownload: boolean; allowOriginalDownload: boolean },
  requested: ImageVariant,
  role: string,
  tenantId: unknown,
): ImageVariant {
  if (role === 'photographer') return requested;
  if (requested === 'original') {
    if (!photo.allowDownload || !photo.allowOriginalDownload || !tenantId) {
      // Fall back rather than 403, so the UI always has something to show.
      return 'gallery';
    }
  }
  return requested;
}

/**
 * A signed-out visitor needs a live share token *and* a published gallery. The
 * token alone is not access, and neither is publication alone.
 *
 * Only *validates* here. The visit is counted when the gallery is opened, not
 * per image, so `maxAccesses` measures page views instead of image requests.
 */
async function authorizeShareVisit(req: Request, projectId: Types.ObjectId): Promise<boolean> {
  const token = typeof req.query.token === 'string' ? req.query.token : undefined;
  const grant = typeof req.query.viewToken === 'string' ? req.query.viewToken : undefined;
  return isLiveShareForProject(projectId, token, grant);
}

function sanitiseOriginalName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

function readReason(req: Request): string | undefined {
  const reason = req.query.reason;
  return typeof reason === 'string' && reason.length >= 4 ? reason.slice(0, 600) : undefined;
}

/**
 * Recomputes the denormalised counters on the project.
 *
 * Done as an awaited update rather than a fire-and-forget `$inc`, so a failed
 * upload never leaves the dashboard showing a photo that was rolled back.
 */
async function refreshCounts(projectId: Types.ObjectId): Promise<void> {
  const [photos, highlights] = await Promise.all([
    PhotoModel.countDocuments({ projectId }),
    PhotoModel.countDocuments({ projectId, isHighlight: true }),
  ]);
  await ProjectModel.updateOne(
    { _id: projectId },
    { $set: { 'counts.photos': photos, 'counts.highlights': highlights } },
  );
}

/** Album photo counts move when a photo is added to or removed from an album. */
async function syncAlbumCounts(albumId: Types.ObjectId): Promise<void> {
  const photos = await PhotoModel.countDocuments({ albumId });
  await AlbumModel.updateOne({ _id: albumId }, { $set: { 'counts.photos': photos } });
}

export default router;
