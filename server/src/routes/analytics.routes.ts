import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/response.js';
import {
  AlbumModel,
  BookingModel,
  FavoriteModel,
  InvoiceModel,
  PaymentModel,
  PhotoModel,
  PhotoSelectionModel,
  ProjectModel,
  TestimonialModel,
  UserModel,
} from '../models/index.js';
import { authenticate } from '../middleware/auth.js';
import { validateQuery, q } from '../middleware/validate.js';
import { ApiError } from '../utils/ApiError.js';

const router = Router();

/**
 * Reporting endpoints.
 *
 * Every figure here is scoped to `req.ctx.tenantId` - a photographer's analytics
 * are their own. Clients have no analytics surface at all; a client asking for
 * "revenue by photographer" is asking for another tenant's books.
 */

const rangeSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /** Predefined window, used when `from` is absent. */
  period: z.enum(['7d', '30d', '90d', '12m', 'all']).default('30d'),
});

const revenueQuerySchema = rangeSchema.extend({
  groupBy: z.enum(['day', 'week', 'month']).default('month'),
});

const bookingsQuerySchema = rangeSchema.extend({
  groupBy: z.enum(['status', 'eventType', 'month']).default('status'),
});

const clientsQuerySchema = rangeSchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

type Range = { from: Date | null; to: Date | null; days: number };

function resolveRange(filters: z.infer<typeof rangeSchema>): Range {
  const to = filters.to ?? new Date();
  // `all` has no lower bound, so `from` stays null and the caller matches everything.
  const from: Date | null = filters.from ?? periodStart(filters.period, to);
  if (!from) return { from: null, to, days: 0 };
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000));
  return { from, to, days };
}

function periodStart(period: z.infer<typeof rangeSchema>['period'], to: Date): Date | null {
  const from = new Date(to);
  switch (period) {
    case '7d':
      from.setDate(from.getDate() - 7);
      return from;
    case '30d':
      from.setDate(from.getDate() - 30);
      return from;
    case '90d':
      from.setDate(from.getDate() - 90);
      return from;
    case '12m':
      from.setFullYear(from.getFullYear() - 1);
      return from;
    case 'all':
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                     */
/* -------------------------------------------------------------------------- */

router.get(
  '/summary',
  authenticate,
  validateQuery(rangeSchema),
  asyncHandler(async (req, res) => {
    const range = resolveRange(q<z.infer<typeof rangeSchema>>(req));
    const tenant = req.ctx.tenantId;
    if (!tenant) throw ApiError.forbidden('Analytics are available to photographer accounts only.');

    const dateFilter = range.from ? { createdAt: { $gte: range.from, $lte: range.to } } : {};

    const [bookings, projects, revenue, paid, outstanding, clients] = await Promise.all([
      BookingModel.find({ photographerId: tenant, ...dateFilter }).select('status priceSnapshot eventDate createdAt').lean(),
      ProjectModel.countDocuments({ photographerId: tenant, ...dateFilter }),
      PaymentModel.aggregate([
        { $match: { photographerId: tenant, status: 'completed', verifiedAt: { $gte: range.from ?? new Date(0), $lte: range.to } } },
        { $group: { _id: null, total: { $sum: '$amountMinor' }, count: { $sum: 1 } } },
      ]),
      PaymentModel.aggregate([
        { $match: { photographerId: tenant, status: 'completed', verifiedAt: { $gte: range.from ?? new Date(0), $lte: range.to } } },
        { $group: { _id: '$currency', total: { $sum: '$amountMinor' } } },
      ]),
      InvoiceModel.aggregate([
        { $match: { photographerId: tenant, status: { $ne: 'paid' } } },
        { $group: { _id: null, remaining: { $sum: '$remainingMinor' }, count: { $sum: 1 } } },
      ]),
      BookingModel.distinct('clientId', { photographerId: tenant }),
    ]);

    const byStatus = bookings.reduce<Record<string, number>>((acc, b) => {
      acc[b.status] = (acc[b.status] ?? 0) + 1;
      return acc;
    }, {});

    const bookedMinor = bookings.reduce((sum, b) => sum + b.priceSnapshot.totalMinor, 0);

    return ok(res, {
      range: { from: range.from, to: range.to, days: range.days },
      bookings: {
        total: bookings.length,
        byStatus,
        bookedMinor,
        conversion:
          bookings.length === 0
            ? 0
            : Math.round(((byStatus.approved ?? 0) / bookings.length) * 1000) / 10,
      },
      revenue: {
        receivedMinor: revenue[0]?.total ?? 0,
        transactions: revenue[0]?.count ?? 0,
        byCurrency: paid,
        outstandingMinor: outstanding[0]?.remaining ?? 0,
        outstandingInvoices: outstanding[0]?.count ?? 0,
      },
      projects,
      clients: clients.length,
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Revenue                                                                     */
/* -------------------------------------------------------------------------- */

router.get(
  '/revenue',
  authenticate,
  validateQuery(revenueQuerySchema),
  asyncHandler(async (req, res) => {
    const filters = q<z.infer<typeof revenueQuerySchema>>(req);
    const range = resolveRange(filters);
    const tenant = req.ctx.tenantId;
    if (!tenant) throw ApiError.forbidden('Analytics are available to photographer accounts only.');

    /* Grouped on `verifiedAt`, not `paidAt`: Payment has no `paidAt` field, so
     * matching and grouping on one silently produced zero revenue rows. */
    const groupId =
      filters.groupBy === 'day'
        ? { $dateToString: { format: '%Y-%m-%d', date: '$verifiedAt' } }
        : filters.groupBy === 'week'
          ? { $dateToString: { format: '%G-W%V', date: '$verifiedAt' } }
          : { $dateToString: { format: '%Y-%m', date: '$verifiedAt' } };

    const rows = await PaymentModel.aggregate([
      { $match: { photographerId: tenant, status: 'completed', verifiedAt: { $gte: range.from ?? new Date(0), $lte: range.to } } },
      {
        $group: {
          _id: groupId,
          minor: { $sum: '$amountMinor' },
          count: { $sum: 1 },
          // `$ifNull` is the aggregation-side equivalent of `?? 0`; a plain `??`
          // inside the pipeline is parsed as a field path by MongoDB and silently
          // yields null.
          feesMinor: {
            $sum: { $multiply: ['$amountMinor', { $divide: [{ $ifNull: ['$gatewayFeeMinor', 0] }, 1_000_000] }] },
          },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const totalMinor = rows.reduce((sum, row) => sum + row.minor, 0);

    return ok(res, {
      range: { from: range.from, to: range.to },
      groupBy: filters.groupBy,
      series: rows.map((row) => ({
        period: String(row._id),
        minor: row.minor,
        transactions: row.count,
        feesMinor: row.feesMinor,
      })),
      totalMinor,
      averageTransactionMinor: rows.length === 0 ? 0 : Math.round(totalMinor / rows.length),
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Bookings                                                                    */
/* -------------------------------------------------------------------------- */

router.get(
  '/bookings',
  authenticate,
  validateQuery(bookingsQuerySchema),
  asyncHandler(async (req, res) => {
    const filters = q<z.infer<typeof bookingsQuerySchema>>(req);
    const range = resolveRange(filters);
    const tenant = req.ctx.tenantId;
    if (!tenant) throw ApiError.forbidden('Analytics are available to photographer accounts only.');

    const groupId =
      filters.groupBy === 'eventType'
        ? '$eventType'
        : filters.groupBy === 'month'
          ? { $dateToString: { format: '%Y-%m', date: '$eventDate' } }
          : '$status';

    const rows = await BookingModel.aggregate([
      { $match: { photographerId: tenant, createdAt: { $gte: range.from ?? new Date(0), $lte: range.to } } },
      { $group: { _id: groupId, count: { $sum: 1 }, value: { $sum: '$priceSnapshot.totalMinor' } } },
      { $sort: { count: -1 } },
    ]);

    return ok(res, {
      range: { from: range.from, to: range.to },
      groupBy: filters.groupBy,
      groups: rows.map((row) => ({ key: String(row._id), count: row.count, valueMinor: row.value })),
      total: rows.reduce((sum, row) => sum + row.count, 0),
      valueMinor: rows.reduce((sum, row) => sum + row.value, 0),
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Clients                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Engagement per client: how many shoots, how much they have spent, and whether
 * they came back.
 */
router.get(
  '/clients',
  authenticate,
  validateQuery(clientsQuerySchema),
  asyncHandler(async (req, res) => {
    const filters = q<z.infer<typeof clientsQuerySchema>>(req);
    const range = resolveRange(filters);
    const tenant = req.ctx.tenantId;
    if (!tenant) throw ApiError.forbidden('Analytics are available to photographer accounts only.');

    const rows = await BookingModel.aggregate([
      { $match: { photographerId: tenant } },
      {
        $group: {
          _id: '$clientId',
          bookings: { $sum: 1 },
          spentMinor: { $sum: '$priceSnapshot.totalMinor' },
          lastBookingAt: { $max: '$eventDate' },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
        },
      },
      { $sort: { spentMinor: -1 } },
      { $limit: filters.limit },
    ]);

    const ids = rows.map((row) => row._id);
    const users = await UserModel.find({ _id: { $in: ids } }).select('_id name email phone avatar').lean();

    // `users` is keyed by `_id`, which is the same value as the booking
    // `clientId`, so it is the only lookup needed for contact details.
    const byId = new Map(users.map((user) => [String(user._id), user]));

    return ok(res, {
      clients: rows.map((row) => {
        const record = byId.get(String(row._id));
        return {
          clientId: String(row._id),
          name: record?.name ?? 'Client',
          email: record?.email ?? '',
          phone: record?.phone ?? '',
          avatar: record?.avatar ?? '',
          bookings: row.bookings,
          cancelled: row.cancelled,
          spentMinor: row.spentMinor,
          lastBookingAt: row.lastBookingAt,
          repeat: row.bookings - row.cancelled > 1,
        };
      }),
      range: { from: range.from, to: range.to },
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Gallery engagement                                                          */
/* -------------------------------------------------------------------------- */

/**
 * How much clients actually use their galleries: visits, favourites, selections.
 *
 * Share access counts come from `GalleryShare.accessCount`, which is incremented
 * once per authenticated resolve rather than per image request, so a page reload
 * does not inflate the number.
 */
router.get(
  '/engagement',
  authenticate,
  validateQuery(rangeSchema),
  asyncHandler(async (req, res) => {
    const range = resolveRange(q<z.infer<typeof rangeSchema>>(req));
    const tenant = req.ctx.tenantId;
    if (!tenant) throw ApiError.forbidden('Analytics are available to photographer accounts only.');

    const projectFilter = { photographerId: tenant, createdAt: { $gte: range.from ?? new Date(0), $lte: range.to } };

    const inRange = { $gte: range.from ?? new Date(0), $lte: range.to };
    const [projects, photos, selections, albums, favorites, published] = await Promise.all([
      ProjectModel.find(projectFilter).select('title status gallery eventDate counts').lean(),
      PhotoModel.countDocuments({ photographerId: tenant, uploadedAt: inRange }),
      PhotoSelectionModel.countDocuments({ photographerId: tenant, createdAt: inRange }),
      AlbumModel.countDocuments({ photographerId: tenant }),
      FavoriteModel.countDocuments({ photographerId: tenant, createdAt: inRange }),
      ProjectModel.find({ photographerId: tenant, 'gallery.published': true })
        .select('_id gallery')
        .lean(),
    ]);

    return ok(res, {
      range: { from: range.from, to: range.to },
      photosUploaded: photos,
      selectionsMade: selections,
      favoritesGiven: favorites,
      albums,
      publishedGalleries: published.length,
      projects: projects.map((p) => ({
        id: String(p._id),
        title: p.title,
        status: p.status,
        eventDate: p.eventDate,
        publishedAt: p.gallery?.publishedAt ?? null,
        counts: p.counts,
      })),
      averages: {
        selectionsPerProject:
          projects.length === 0 ? 0 : Math.round((selections / projects.length) * 10) / 10,
        favoritesPerPhoto: photos === 0 ? 0 : Math.round((favorites / photos) * 100) / 100,
      },
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Social proof                                                                */
/* -------------------------------------------------------------------------- */

router.get(
  '/testimonials',
  authenticate,
  asyncHandler(async (req, res) => {
    const tenant = req.ctx.tenantId;
    if (!tenant) throw ApiError.forbidden('Analytics are available to photographer accounts only.');

    const rows = await TestimonialModel.find({ photographerId: tenant }).sort({ createdAt: -1 }).lean();
    const approved = rows.filter((t) => t.approved);
    const average = approved.length === 0
      ? 0
      : Math.round((approved.reduce((sum, t) => sum + t.rating, 0) / approved.length) * 10) / 10;

    return ok(res, {
      average,
      total: rows.length,
      approved: approved.length,
      awaitingReview: rows.length - approved.length,
      distribution: [5, 4, 3, 2, 1].map((star) => ({
        star,
        count: rows.filter((t) => t.rating === star).length,
      })),
      recent: approved.slice(0, 5).map((t) => ({
        id: String(t._id),
        rating: t.rating,
        content: t.content,
        authorName: t.authorName,
        createdAt: t.createdAt,
      })),
    });
  }),
);

export default router;
