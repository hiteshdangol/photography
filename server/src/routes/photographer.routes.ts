import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/response.js';
import {
  PackageModel,
  PhotographerProfileModel,
  PortfolioItemModel,
  ServiceModel,
  TestimonialModel,
  UserModel,
} from '../models/index.js';
import { authenticate, requirePhotographer } from '../middleware/auth.js';
import { validateBody, validateQuery, q } from '../middleware/validate.js';
import { ApiError } from '../utils/ApiError.js';
import { escapeRegex, slugify, uniqueSlug } from '../utils/slug.js';
import { paginated } from '../utils/pagination.js';
import { directoryLimiter } from '../middleware/rateLimit.js';
import { CATEGORY_KEYS } from '../config/categories.js';
import { rangeAvailability } from '../services/availability.js';

const router = Router();

/* -------------------------------------------------------------------------- */
/* Public directory                                                            */
/* -------------------------------------------------------------------------- */

const directorySchema = z.object({
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(40).optional(),
  location: z.string().trim().max(120).optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  availableFrom: z.coerce.date().optional(),
  availableTo: z.coerce.date().optional(),
  sort: z.enum(['rating', 'price_asc', 'price_desc', 'newest', 'featured']).default('featured'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(60).default(12),
});

/**
 * The public photographer directory.
 *
 * Only `published` profiles of `active` photographers are ever returned, and
 * nothing private (email, phone, revenue) is selected.
 */
router.get(
  '/',
  directoryLimiter,
  validateQuery(directorySchema),
  asyncHandler(async (req, res) => {
    const filters = q<z.infer<typeof directorySchema>>(req);
    const pagination = {
      page: filters.page,
      limit: filters.limit,
      skip: (filters.page - 1) * filters.limit,
    };

    const profileFilter: Record<string, unknown> = { published: true };
    if (filters.category) {
      if (!CATEGORY_KEYS.includes(filters.category as (typeof CATEGORY_KEYS)[number])) {
        throw ApiError.badRequest('Unknown photography category.');
      }
      profileFilter.specialties = filters.category;
    }
    if (filters.location) {
      profileFilter.$or = [
        { location: { $regex: escapeRegex(filters.location), $options: 'i' } },
        { 'address.city': { $regex: escapeRegex(filters.location), $options: 'i' } },
      ];
    }
    if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
      profileFilter.startingPrice = {
        ...(filters.minPrice !== undefined ? { $gte: filters.minPrice } : {}),
        ...(filters.maxPrice !== undefined ? { $lte: filters.maxPrice } : {}),
      };
    }
    if (filters.minRating !== undefined) {
      profileFilter['rating.average'] = { $gte: filters.minRating };
    }

    // Text search across name, tagline, bio and location.
    if (filters.q) {
      const rx = new RegExp(escapeRegex(filters.q), 'i');
      profileFilter.$and = [
        {
          $or: [
            { businessName: rx },
            { tagline: rx },
            { bio: rx },
            { location: rx },
            { specialties: rx },
          ],
        },
      ];
      // A separate $or for location would collide with the one above.
      if (filters.location) delete profileFilter.$or;
    }

    const sortMap: Record<string, Record<string, 1 | -1>> = {
      rating: { 'rating.average': -1, 'rating.count': -1 },
      price_asc: { startingPrice: 1 },
      price_desc: { startingPrice: -1 },
      newest: { createdAt: -1 },
      featured: { featured: -1, 'rating.average': -1, createdAt: -1 },
    };

    const profiles = await PhotographerProfileModel.find(profileFilter)
      .sort(sortMap[filters.sort] ?? sortMap.featured!)
      .skip(pagination.skip)
      .limit(pagination.limit)
      .populate<{ _id: { name: string; avatar: string | null } }>('userId', 'name avatar')
      .lean();

    // Restrict the result set to active accounts (a suspended photographer must
    // disappear from the public site immediately).
    const activeUserIds = await UserModel.find({
      _id: { $in: profiles.map((p) => p.userId) },
      role: 'photographer',
      status: 'active',
    })
      .select('_id name avatar emailVerified')
      .lean();
    const activeById = new Map(activeUserIds.map((u) => [String(u._id), u]));

    let items = profiles
      .filter((p) => activeById.has(String(p.userId)))
      .map((p) => ({
        ...p,
        id: String(p._id),
        owner: activeById.get(String(p.userId)) ?? null,
        coverImage: p.portfolioCover ?? p.coverImage ?? p.profileImage ?? null,
      }));

    // Availability filter: only photographers with real free windows in range.
    if (filters.availableFrom || filters.availableTo) {
      const from = filters.availableFrom ?? new Date();
      const to = filters.availableTo ?? new Date(from.getTime() + 60 * 24 * 60 * 60 * 1000);
      const checked = await Promise.all(
        items.map(async (item) => {
          const days = await rangeAvailability(item.userId, from, to);
          return { item, hasSlot: days.some((d) => d.available) };
        }),
      );
      items = checked.filter((c) => c.hasSlot).map((c) => c.item);
    }

    // `total` reflects the post-filter count so pagination stays honest.
    const total = items.length === pagination.limit
      ? await countMatching(profileFilter)
      : pagination.skip + items.length;

    return ok(res, paginated(items, total, pagination), 'Photographers found.', {
      filters: { ...filters, page: undefined, limit: undefined },
    });
  }),
);

async function countMatching(filter: Record<string, unknown>): Promise<number> {
  const ids = await PhotographerProfileModel.find(filter).select('userId').lean();
  const active = await UserModel.countDocuments({
    _id: { $in: ids.map((i) => i.userId) },
    role: 'photographer',
    status: 'active',
  });
  return active;
}

/* -------------------------------------------------------------------------- */
/* Public profile                                                              */
/* -------------------------------------------------------------------------- */

/** SEO-friendly slug route: /photographers/john-photography */
router.get(
  '/slug/:slug',
  directoryLimiter,
  asyncHandler(async (req, res) => {
    const profile = await PhotographerProfileModel.findOne({ slug: req.params.slug, published: true }).lean();
    if (!profile) throw ApiError.notFound('We could not find that photographer.');

    const owner = await UserModel.findOne({ _id: profile.userId, role: 'photographer', status: 'active' })
      .select('name avatar emailVerified createdAt')
      .lean();
    if (!owner) throw ApiError.notFound('We could not find that photographer.');

    const [packages, services, portfolio, testimonials] = await Promise.all([
      PackageModel.find({ photographerId: profile.userId, active: true }).sort({ sortOrder: 1, price: 1 }).lean(),
      ServiceModel.find({ photographerId: profile.userId, active: true }).sort({ sortOrder: 1 }).lean(),
      PortfolioItemModel.find({ photographerId: profile.userId, published: true })
        .sort({ featured: -1, sortOrder: 1 })
        .limit(48)
        .lean(),
      TestimonialModel.find({ photographerId: profile.userId, approved: true })
        .sort({ featured: -1, createdAt: -1 })
        .limit(12)
        .lean(),
    ]);

    return ok(res, {
      profile: { ...profile, id: String(profile._id), owner },
      packages,
      services,
      portfolio,
      testimonials,
    });
  }),
);

/** Every photographer, alphabetically, for the /photographers page header. */
router.get(
  '/suggestions',
  asyncHandler(async (_req, res) => {
    const suggestions = await PhotographerProfileModel.find({ published: true })
      .sort({ featured: -1, 'rating.average': -1 })
      .select('slug businessName location specialties startingPrice rating featured')
      .limit(24)
      .lean();
    return ok(res, { suggestions });
  }),
);

/* -------------------------------------------------------------------------- */
/* The signed-in photographer's own profile                                    */
/* -------------------------------------------------------------------------- */

router.get(
  '/me',
  authenticate,
  requirePhotographer,
  asyncHandler(async (req, res) => {
    const profile = await PhotographerProfileModel.findOne({ userId: req.ctx.tenantId }).lean();
    if (!profile) throw ApiError.notFound('Create your business profile first.');
    return ok(res, { profile });
  }),
);

const profileSchema = z.object({
  businessName: z.string().trim().min(2, 'Enter your business name.').max(120).optional(),
  tagline: z.string().trim().max(160).optional(),
  bio: z.string().trim().max(4000).optional(),
  location: z.string().trim().max(120).optional(),
  address: z
    .object({
      city: z.string().trim().max(80).optional(),
      area: z.string().trim().max(80).optional(),
      country: z.string().trim().max(80).optional(),
    })
    .optional(),
  specialties: z.array(z.enum(CATEGORY_KEYS as [string, ...string[]])).max(13).optional(),
  yearsExperience: z.number().int().min(0).max(70).nullable().optional(),
  website: z.string().trim().max(200).optional(),
  instagram: z.string().trim().max(120).optional(),
  facebook: z.string().trim().max(200).optional(),
  whatsapp: z.string().trim().max(30).optional(),
  published: z.boolean().optional(),
  settings: z
    .object({
      currency: z.string().trim().max(8).optional(),
      depositType: z.enum(['percent', 'fixed', 'full', 'none']).optional(),
      depositValue: z.number().min(0).max(100).optional(),
      requireDeposit: z.boolean().optional(),
      allowClientDownloads: z.boolean().optional(),
      allowOriginalDownloads: z.boolean().optional(),
      autoTimeline: z.boolean().optional(),
      reminderDaysBefore: z.number().int().min(0).max(60).optional(),
      galleryLinkDefaultExpiryDays: z.number().int().min(1).max(365).optional(),
    })
    .optional(),
});

router.patch(
  '/me',
  authenticate,
  requirePhotographer,
  validateBody(profileSchema),
  asyncHandler(async (req, res) => {
    // The tenant is always the caller's own user id; it is never read from the body.
    const tenantId = req.ctx.tenantId!;

    let profile = await PhotographerProfileModel.findOne({ userId: tenantId });
    if (!profile) {
      const slug = await uniqueSlug(slugify(req.body.businessName ?? 'Studio'), async (candidate) =>
        Boolean(await PhotographerProfileModel.findOne({ slug: candidate }).select('_id').lean()),
      );
      profile = new PhotographerProfileModel({
        userId: tenantId,
        businessName: req.body.businessName ?? 'My Studio',
        slug,
      });
    }

    // A published profile must have a slug that matches its public name.
    if (req.body.businessName && req.body.businessName !== profile.businessName) {
      profile.businessName = req.body.businessName;
      profile.slug = await uniqueSlug(slugify(req.body.businessName), async (candidate) =>
        Boolean(
          await PhotographerProfileModel.findOne({ slug: candidate, _id: { $ne: profile!._id } })
            .select('_id')
            .lean(),
        ),
      );
    }

    // `businessName` is excluded because it was already applied above, together
    // with the slug it implies. Re-assigning it here would bypass that.
    const { businessName: _businessName, ...rest } = req.body;
    Object.assign(profile, rest);
    await profile.save();

    return ok(res, { profile }, 'Profile saved.');
  }),
);

const avatarSchema = z.object({
  url: z.string().trim().max(500),
});

/** Set after an avatar upload has been processed by the portfolio route. */
router.patch(
  '/me/avatar',
  authenticate,
  requirePhotographer,
  validateBody(avatarSchema),
  asyncHandler(async (req, res) => {
    await UserModel.updateOne({ _id: req.ctx.userId }, { $set: { avatar: req.body.url } });
    await PhotographerProfileModel.updateOne(
      { userId: req.ctx.tenantId },
      { $set: { profileImage: req.body.url } },
    );
    return ok(res, { saved: true }, 'Photo updated.');
  }),
);

export default router;
