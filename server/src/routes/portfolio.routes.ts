import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created, noContent } from '../utils/response.js';
import { PhotographerProfileModel, PortfolioItemModel } from '../models/index.js';
import { authenticate, requirePhotographer, optionalAuthenticate } from '../middleware/auth.js';
import { validateBody, validateQuery, q } from '../middleware/validate.js';
import { singleImageUpload, runUpload } from '../middleware/upload.js';
import { ApiError } from '../utils/ApiError.js';
import { PORTFOLIO_ERRORS } from '../messages.js';
import { objectId } from '../services/authorization.js';
import { processImage, safeFilename } from '../services/image/pipeline.js';
import { getStorage } from '../services/storage/index.js';
import type { RequestContext } from '../types/express.js';

const router = Router();

const BUCKET = 'portfolio';

/* -------------------------------------------------------------------------- */
/* Public portfolio                                                             */
/* -------------------------------------------------------------------------- */

const publicListSchema = z.object({
  category: z.string().trim().max(60).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(48).default(24),
});

/**
 * A photographer's published portfolio - the shop window.
 *
 * Unauthenticated on purpose. Only published items from a published profile are
 * returned, and only display fields: no storage keys, no project links, no
 * client identity. Images are streamed by the authorised media route below.
 */
router.get(
  '/:slug',
  optionalAuthenticate,
  validateQuery(publicListSchema),
  asyncHandler(async (req, res) => {
    const filters = q<z.infer<typeof publicListSchema>>(req);
    const { slug } = req.params;

    const profile = await PhotographerProfileModel.findOne({ slug, published: true })
      .select('userId businessName tagline bio location specialties rating website instagram facebook whatsapp startingPrice profileImage coverImage portfolioCover')
      .lean();
    if (!profile) throw ApiError.notFound(PORTFOLIO_ERRORS.noProfile);

    // Portfolio items are keyed by the owning user id, not the profile id.
    const filter: Record<string, unknown> = { photographerId: profile.userId, published: true };
    if (filters.category) filter.categoryKey = filters.category;

    const skip = (filters.page - 1) * filters.limit;
    const [items, total] = await Promise.all([
      PortfolioItemModel.find(filter).sort({ sortOrder: 1, createdAt: -1 }).skip(skip).limit(filters.limit).lean(),
      PortfolioItemModel.countDocuments(filter),
    ]);

    return ok(res, {
      photographer: {
        slug,
        businessName: profile.businessName,
        tagline: profile.tagline,
        bio: profile.bio,
        location: profile.location,
        specialties: profile.specialties,
        rating: profile.rating,
        social: {
          website: profile.website,
          instagram: profile.instagram,
          facebook: profile.facebook,
          whatsapp: profile.whatsapp,
        },
        startingPrice: profile.startingPrice,
        coverImage: profile.portfolioCover ?? profile.coverImage ?? profile.profileImage,
      },
      items: items.map((item) => toPublicItem(item)),
      pagination: {
        page: filters.page,
        limit: filters.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / filters.limit)),
      },
    });
  }),
);

/**
 * Stream one portfolio image.
 *
 * Public because portfolio work is published marketing material, but only for
 * items that are actually published - an unpublished item's bytes stay private
 * even if someone guesses its id.
 */
router.get(
  '/image/:id',
  optionalAuthenticate,
  asyncHandler(async (req, res) => {
    const item = await PortfolioItemModel.findById(objectId(req.params.id, 'portfolio item id')).lean();
    if (!item || !item.published) throw ApiError.notFound(PORTFOLIO_ERRORS.notFound);

    const variant = req.query.variant === 'large' ? 'large' : 'thumbnail';
    const key = variant === 'large' ? item.imageKey : item.thumbnailKey;

    const stream = await getStorage().getStream(key);
    res.setHeader('Content-Type', item.mimeType || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    stream.pipe(res);
  }),
);

/* -------------------------------------------------------------------------- */
/* Photographer management                                                      */
/* -------------------------------------------------------------------------- */

const listSchema = z.object({
  category: z.string().trim().max(60).optional(),
  published: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

router.get(
  '/',
  authenticate,
  requirePhotographer,
  validateQuery(listSchema),
  asyncHandler(async (req, res) => {
    const filters = q<z.infer<typeof listSchema>>(req);
    const filter: Record<string, unknown> = { photographerId: req.ctx.tenantId };
    if (filters.category) filter.categoryKey = filters.category;
    if (filters.published !== undefined) filter.published = filters.published === 'true';

    const items = await PortfolioItemModel.find(filter).sort({ sortOrder: 1, createdAt: -1 }).limit(filters.limit).lean();
    return ok(res, {
      items: items.map((item) => ({ ...toPublicItem(item), published: item.published, featured: item.featured, createdAt: item.createdAt })),
      total: items.length,
    });
  }),
);

const createSchema = z.object({
  title: z.string().trim().min(2, 'Give the image a title.').max(160),
  description: z.string().trim().max(1000).optional(),
  categoryKey: z.string().trim().max(60).optional(),
  projectId: z.string().optional(),
  sortOrder: z.number().int().min(0).optional(),
  published: z.boolean().optional(),
  featured: z.boolean().optional(),
});

/**
 * Upload one portfolio image.
 *
 * Storage is written first and the row second. If the database write fails the
 * bytes are removed again, so a failed upload cannot leave an unreferenced
 * object behind or, worse, a row pointing at nothing.
 */
router.post(
  '/',
  authenticate,
  requirePhotographer,
  runUpload(singleImageUpload),
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) throw ApiError.badRequest('No image was uploaded.');

    const baseName = safeFilename(`pf-${String(req.ctx.tenantId)}-${Date.now()}`);
    const { image, buffers } = await processImage(file.buffer, baseName, BUCKET);
    const storage = getStorage();
    const written: string[] = [];

    try {
      const large = await storage.put(buffers.optimized, { bucket: BUCKET, key: image.optimizedKey, contentType: image.mimeType });
      const thumb = await storage.put(buffers.thumbnail, { bucket: BUCKET, key: image.thumbnailKey, contentType: image.mimeType });
      written.push(large.key, thumb.key);

      const item = await PortfolioItemModel.create({
        photographerId: req.ctx.tenantId!,
        title: req.body.title,
        description: req.body.description ?? '',
        categoryKey: req.body.categoryKey ?? '',
        imageKey: large.key,
        thumbnailKey: thumb.key,
        width: image.width,
        height: image.height,
        aspectRatio: image.aspectRatio,
        blurDataUrl: image.blurDataUrl,
        size: image.optimizedSize,
        mimeType: image.mimeType,
        ...(req.body.projectId ? { projectId: objectId(req.body.projectId, 'project id') } : {}),
        sortOrder: req.body.sortOrder ?? 0,
        published: req.body.published ?? false,
        featured: req.body.featured ?? false,
      });

      return created(res, { item: { ...toPublicItem(item.toObject()), published: item.published } }, 'Added to portfolio.');
    } catch (error) {
      for (const key of written) {
        try {
          await storage.delete(key);
        } catch {
          /* best effort */
        }
      }
      throw error;
    }
  }),
);

const updateSchema = z.object({
  title: z.string().trim().min(2).max(160).optional(),
  description: z.string().trim().max(1000).optional(),
  categoryKey: z.string().trim().max(60).optional(),
  sortOrder: z.number().int().min(0).optional(),
  published: z.boolean().optional(),
  featured: z.boolean().optional(),
});

router.patch(
  '/:id',
  authenticate,
  requirePhotographer,
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    const item = await assertOwned(req.params.id, req.ctx);

    if (req.body.title !== undefined) item.title = req.body.title;
    if (req.body.description !== undefined) item.description = req.body.description;
    if (req.body.categoryKey !== undefined) item.categoryKey = req.body.categoryKey;
    if (req.body.sortOrder !== undefined) item.sortOrder = req.body.sortOrder;
    if (req.body.published !== undefined) item.published = req.body.published;
    if (req.body.featured !== undefined) item.featured = req.body.featured;

    await item.save();
    return ok(res, { item: { ...toPublicItem(item.toObject()), published: item.published, featured: item.featured } }, 'Portfolio item updated.');
  }),
);

router.delete(
  '/:id',
  authenticate,
  requirePhotographer,
  asyncHandler(async (req, res) => {
    const item = await assertOwned(req.params.id, req.ctx);
    const keys = [item.imageKey, item.thumbnailKey];

    await item.deleteOne();
    const storage = getStorage();
    for (const key of keys) {
      try {
        await storage.delete(key);
      } catch {
        /* best effort: orphaned bytes are cheaper than a failed delete */
      }
    }
    return noContent(res, 'Removed from portfolio.');
  }),
);

const reorderSchema = z.object({ itemIds: z.array(z.string()).min(1).max(300) });

router.put(
  '/reorder',
  authenticate,
  requirePhotographer,
  validateBody(reorderSchema),
  asyncHandler(async (req, res) => {
    const ids = (req.body.itemIds as string[]).map((id) => objectId(id, 'portfolio item id'));
    const owned = await PortfolioItemModel.countDocuments({ _id: { $in: ids }, photographerId: req.ctx.tenantId });
    if (owned !== ids.length) throw ApiError.badRequest(PORTFOLIO_ERRORS.notYours);

    await PortfolioItemModel.bulkWrite(
      ids.map((id, index) => ({ updateOne: { filter: { _id: id }, update: { $set: { sortOrder: index } } } })),
    );
    return ok(res, { reordered: ids.length }, 'Order saved.');
  }),
);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

type ItemShape = {
  _id: unknown;
  title: string;
  description: string;
  categoryKey: string;
  width: number;
  height: number;
  aspectRatio: number;
  blurDataUrl: string;
  sortOrder: number;
};

/** `storageKey` is derived, never stored twice, and never exposed. */
function toPublicItem(item: ItemShape) {
  return {
    id: String(item._id),
    title: item.title,
    description: item.description,
    category: item.categoryKey,
    width: item.width,
    height: item.height,
    aspectRatio: item.aspectRatio,
    blurDataUrl: item.blurDataUrl,
    thumbUrl: `/api/portfolio/image/${String(item._id)}`,
    largeUrl: `/api/portfolio/image/${String(item._id)}?variant=large`,
    sortOrder: item.sortOrder,
  };
}

async function assertOwned(id: string, ctx: RequestContext) {
  const item = await PortfolioItemModel.findById(objectId(id, 'portfolio item id'));
  if (!item) throw ApiError.notFound(PORTFOLIO_ERRORS.notFound);
  if (String(item.photographerId) !== String(ctx.tenantId)) {
    throw ApiError.notFound(PORTFOLIO_ERRORS.notFound);
  }
  return item;
}

export default router;
