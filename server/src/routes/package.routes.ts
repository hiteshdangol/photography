import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created } from '../utils/response.js';
import { PackageModel, PhotographerProfileModel } from '../models/index.js';
import { authenticate, optionalAuthenticate, requirePhotographer } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { ApiError } from '../utils/ApiError.js';
import { slugify, uniqueSlug } from '../utils/slug.js';
import { computeDeposit, toMinor } from '../utils/money.js';
import { assertTenantOwner, objectId, tenantFilter } from '../services/authorization.js';
import { refreshStartingPrice } from '../services/pricing.js';
import { parsePagination, paginated } from '../utils/pagination.js';
import { directoryLimiter } from '../middleware/rateLimit.js';

const router = Router();

/**
 * Packages are entirely photographer-defined. Nothing is hardcoded: the
 * example Basic/Premium/Luxury tiers in the brief are just three rows a
 * photographer might create.
 */
const packageSchema = z.object({
  name: z.string().trim().min(2, 'Give the package a name.').max(80),
  description: z.string().trim().max(2000).optional(),
  price: z.number().min(0, 'Price cannot be negative.'),
  currency: z.string().trim().max(8).optional(),
  depositType: z.enum(['percent', 'fixed', 'full', 'none']).default('percent'),
  depositValue: z.number().min(0).default(30),
  durationHours: z.number().min(0).max(24).default(4),
  photographers: z.number().int().min(0).max(20).default(1),
  videographers: z.number().int().min(0).max(20).default(0),
  editedPhotoCount: z.number().int().min(0).default(0),
  turnaroundDays: z.number().int().min(0).max(365).default(21),
  includedServices: z.array(z.string().trim().min(1).max(200)).max(40).optional(),
  deliverables: z.array(z.string().trim().min(1).max(200)).max(40).optional(),
  categoryKeys: z.array(z.string().trim().max(40)).max(20).optional(),
  active: z.boolean().optional(),
  featured: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  includesHighlightAlbum: z.boolean().optional(),
  includesPrintedAlbum: z.boolean().optional(),
});

/**
 * Recomputes the minor-unit mirrors. Always done server-side: a client that
 * posts a hand-crafted `priceMinor` is ignored, because the schema strips
 * unknown keys.
 */
function deriveAmounts(input: z.infer<typeof packageSchema>) {
  const priceMinor = toMinor(input.price);
  const depositMinor = computeDeposit(priceMinor, input.depositType, input.depositValue);
  return { priceMinor, depositMinor };
}



/** Public: a photographer's published packages. */
router.get(
  '/photographer/:photographerId',
  optionalAuthenticate,
  asyncHandler(async (req, res) => {
    const photographerId = objectId(req.params.photographerId, 'photographer id');
    const packages = await PackageModel.find({ photographerId, active: true })
      .sort({ sortOrder: 1, price: 1 })
      .lean();
    return ok(res, { packages });
  }),
);

/**
 * Public: browse packages across the platform, for the marketing /packages page.
 * Paginated because a mature directory has thousands of them.
 */
router.get(
  '/',
  directoryLimiter,
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        category: z.string().trim().optional(),
        minPrice: z.coerce.number().min(0).optional(),
        maxPrice: z.coerce.number().min(0).optional(),
        page: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(60).optional(),
      })
      .parse(req.query);
    const pagination = parsePagination({
      page: parsed.page ? String(parsed.page) : undefined,
      limit: parsed.limit ? String(parsed.limit) : undefined,
    } as never);

    const filter: Record<string, unknown> = { active: true };
    if (parsed.category) filter.categoryKeys = parsed.category;
    if (parsed.minPrice !== undefined || parsed.maxPrice !== undefined) {
      filter.price = {
        ...(parsed.minPrice !== undefined ? { $gte: parsed.minPrice } : {}),
        ...(parsed.maxPrice !== undefined ? { $lte: parsed.maxPrice } : {}),
      };
    }

    const [items, total] = await Promise.all([
      PackageModel.find(filter)
        .sort({ featured: -1, price: 1 })
        .skip(pagination.skip)
        .limit(pagination.limit)
        .populate('photographerId', 'name avatar')
        .lean(),
      PackageModel.countDocuments(filter),
    ]);

    return ok(res, paginated(items, total, pagination));
  }),
);

router.get(
  '/mine',
  authenticate,
  requirePhotographer,
  asyncHandler(async (req, res) => {
    const packages = await PackageModel.find(tenantFilter(req.ctx))
      .sort({ sortOrder: 1, price: 1 })
      .lean();
    return ok(res, { packages });
  }),
);

router.get(
  '/:id',
  optionalAuthenticate,
  asyncHandler(async (req, res) => {
    const pkg = await PackageModel.findById(req.params.id).lean();
    if (!pkg) throw ApiError.notFound('Package not found.');
    // Inactive packages stay visible to their owner for editing.
    if (!pkg.active) {
      const isOwner = req.ctx && String(pkg.photographerId) === String(req.ctx.tenantId);
      if (!isOwner) throw ApiError.notFound('Package not found.');
    }
    return ok(res, { package: pkg });
  }),
);

router.post(
  '/',
  authenticate,
  requirePhotographer,
  validateBody(packageSchema),
  asyncHandler(async (req, res) => {
    const photographerId = req.ctx.tenantId!;
    const profile = await PhotographerProfileModel.findOne({ userId: photographerId }).lean();
    const slug = await uniqueSlug(slugify(req.body.name), async (candidate) =>
      Boolean(await PackageModel.findOne({ photographerId, slug: candidate }).select('_id').lean()),
    );
    const pkg = await PackageModel.create({
      ...req.body,
      ...deriveAmounts(req.body),
      photographerId,
      slug,
      currency: req.body.currency ?? profile?.settings?.currency ?? 'NPR',
    });
    await refreshStartingPrice(photographerId);
    return created(res, { package: pkg }, 'Package created.');
  }),
);

router.patch(
  '/:id',
  authenticate,
  requirePhotographer,
  validateBody(packageSchema.partial()),
  asyncHandler(async (req, res) => {
    const pkg = await PackageModel.findById(req.params.id);
    if (!pkg) throw ApiError.notFound('Package not found.');
    assertTenantOwner(req.ctx, pkg.photographerId);

    Object.assign(pkg, req.body);
    // Recompute from whatever price/deposit values the merge produced.
    if (req.body.price !== undefined || req.body.depositType !== undefined || req.body.depositValue !== undefined) {
      const priceMinor = toMinor(pkg.price);
      pkg.priceMinor = priceMinor;
      pkg.depositMinor = computeDeposit(priceMinor, pkg.depositType, pkg.depositValue);
    }
    await pkg.save();
    await refreshStartingPrice(req.ctx.tenantId!);
    return ok(res, { package: pkg }, 'Package updated.');
  }),
);

/** Soft delete: a package referenced by a booking must keep its price snapshot. */
router.delete(
  '/:id',
  authenticate,
  requirePhotographer,
  asyncHandler(async (req, res) => {
    const pkg = await PackageModel.findById(req.params.id);
    if (!pkg) throw ApiError.notFound('Package not found.');
    assertTenantOwner(req.ctx, pkg.photographerId);
    await pkg.deleteOne();
    await refreshStartingPrice(req.ctx.tenantId!);
    return ok(res, { deleted: true }, 'Package removed.');
  }),
);

export default router;
