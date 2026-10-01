import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/response.js';
import { BookingModel, ClientProfileModel, ProjectModel, UserModel } from '../models/index.js';
import { authenticate, requirePhotographer } from '../middleware/auth.js';
import { validateBody, validateQuery, q } from '../middleware/validate.js';
import { ApiError } from '../utils/ApiError.js';
import { objectId, tenantFilter } from '../services/authorization.js';
import { paginated } from '../utils/pagination.js';
import { notify } from '../services/notifications/dispatcher.js';
import { linkClientToPhotographer } from '../services/relationship.js';

const router = Router();

/**
 * Client records are derived from real bookings, never hand-entered. A client
 * only exists in a tenant's book once they have booked.
 */
const listSchema = z.object({
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(24),
});

router.get(
  '/',
  authenticate,
  requirePhotographer,
  validateQuery(listSchema),
  asyncHandler(async (req, res) => {
    const { search, page, limit } = q<z.infer<typeof listSchema>>(req);
    const pagination = { page, limit, skip: (page - 1) * limit };

    // The tenant filter is applied to the *booking* query, so a photographer can
    // only ever discover clients they have actually worked with.
    const bookingFilter: Record<string, unknown> = tenantFilter(req.ctx);

    const clientIds = await BookingModel.distinct('clientId', bookingFilter);

    const userFilter: Record<string, unknown> = {
      _id: { $in: clientIds },
      role: 'client',
    };
    if (search) {
      userFilter.$or = [
        { name: { $regex: escapeRegex(search), $options: 'i' } },
        { email: { $regex: escapeRegex(search), $options: 'i' } },
        { phone: { $regex: escapeRegex(search), $options: 'i' } },
      ];
    }

    const [clients, total] = await Promise.all([
      UserModel.find(userFilter)
        .select('name email phone avatar status createdAt lastLoginAt')
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit)
        .lean(),
      UserModel.countDocuments(userFilter),
    ]);

    // Attach the counts the list view needs, in one aggregation per page.
    const ids = clients.map((c) => c._id);
    const [projectStats, lastBookings] = await Promise.all([
      ProjectModel.aggregate([
        { $match: { clientId: { $in: ids }, photographerId: req.ctx.tenantId } },
        { $group: { _id: '$clientId', projects: { $sum: 1 }, revenue: { $sum: '$totalMinor' } } },
      ]),
      BookingModel.find({ clientId: { $in: ids }, photographerId: req.ctx.tenantId })
        .sort({ eventDate: -1 })
        .select('clientId eventDate eventType status paymentStatus priceSnapshot')
        .lean(),
    ]);

    const statsBy = new Map(projectStats.map((s) => [String(s._id), s]));
    const lastBy = new Map<string, (typeof lastBookings)[number]>();
    for (const b of lastBookings) {
      const key = String(b.clientId);
      if (!lastBy.has(key)) lastBy.set(key, b);
    }

    return ok(
      res,
      paginated(
        clients.map((c) => ({
          ...c,
          id: String(c._id),
          stats: {
            projects: statsBy.get(String(c._id))?.projects ?? 0,
            revenueMinor: statsBy.get(String(c._id))?.revenue ?? 0,
          },
          lastBooking: lastBy.get(String(c._id)) ?? null,
        })),
        total,
        pagination,
      ),
    );
  }),
);

router.get(
  '/:id',
  authenticate,
  requirePhotographer,
  asyncHandler(async (req, res) => {
    const clientId = objectId(req.params.id, 'client id');
    const user = await UserModel.findById(clientId).select('name email phone avatar status createdAt lastLoginAt').lean();
    if (!user || user.role !== 'client') throw ApiError.notFound('Client not found.');

    // Confirm this client actually belongs to this tenant before revealing anything.
    const engagement = await BookingModel.findOne({ clientId, photographerId: req.ctx.tenantId }).select('_id');
    if (!engagement) throw ApiError.notFound('Client not found.');

    const [bookings, projects, profile] = await Promise.all([
      BookingModel.find({ clientId, photographerId: req.ctx.tenantId }).sort({ eventDate: -1 }).lean(),
      ProjectModel.find({ clientId, photographerId: req.ctx.tenantId }).sort({ eventDate: -1 }).lean(),
      ClientProfileModel.findOne({ userId: clientId }).lean(),
    ]);

    return ok(res, {
      client: { ...user, id: String(user._id) },
      clientProfile: profile ?? null,
      bookings,
      projects,
      totals: {
        bookings: bookings.length,
        projects: projects.length,
        revenueMinor: bookings.reduce((sum, b) => sum + (b.paidMinor ?? 0), 0),
        outstandingMinor: bookings.reduce(
          (sum, b) => sum + Math.max(0, (b.priceSnapshot?.totalMinor ?? 0) - (b.paidMinor ?? 0)),
          0,
        ),
      },
    });
  }),
);

const noteSchema = z.object({
  notes: z.string().trim().max(2000),
});

/** Private note the photographer keeps about a client. Never visible to them. */
router.patch(
  '/:id/notes',
  authenticate,
  requirePhotographer,
  validateBody(noteSchema),
  asyncHandler(async (req, res) => {
    const clientId = objectId(req.params.id, 'client id');
    const engagement = await BookingModel.findOne({ clientId, photographerId: req.ctx.tenantId }).select('_id');
    if (!engagement) throw ApiError.notFound('Client not found.');

    // Match on `userId` alone. Filtering on `photographerIds` as well meant the
    // upsert never matched a profile that had not yet been linked to this
    // photographer, so it tried to insert and collided with the unique index on
    // `userId`, returning 409 instead of saving the note.
    const photographerId = req.ctx.tenantId;
    if (!photographerId) throw ApiError.forbidden();
    await linkClientToPhotographer(clientId, photographerId);

    const profile = await ClientProfileModel.findOneAndUpdate(
      { userId: clientId },
      { $set: { 'preferences.notes': req.body.notes } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    return ok(res, { clientProfile: profile }, 'Note saved.');
  }),
);

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().max(100).optional(),
});

/** Nudge a client to complete their profile / leave a testimonial. */
router.post(
  '/:id/invite',
  authenticate,
  requirePhotographer,
  validateBody(inviteSchema),
  asyncHandler(async (req, res) => {
    const clientId = objectId(req.params.id, 'client id');
    const engagement = await BookingModel.findOne({ clientId, photographerId: req.ctx.tenantId }).select('_id');
    if (!engagement) throw ApiError.notFound('Client not found.');

    await notify({
      userId: clientId,
      photographerId: req.ctx.tenantId,
      type: 'testimonial_requested',
      title: 'Share your experience',
      message: 'We would love to hear about your session.',
      link: '/dashboard/testimonials',
      email: true,
    });
    return ok(res, { sent: true }, 'Invitation sent.');
  }),
);

/** Suspending a client is a platform-admin action; see admin.routes. */

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default router;
