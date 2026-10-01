import { Router } from 'express';
import { z } from 'zod';
import type { Types } from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created, noContent } from '../utils/response.js';
import {
  BookingModel,
  PhotographerProfileModel,
  ProjectModel,
  TestimonialModel,
  UserModel,
} from '../models/index.js';
import { authenticate, requireClient, requirePhotographer } from '../middleware/auth.js';
import { validateBody, validateQuery, q } from '../middleware/validate.js';
import { ApiError } from '../utils/ApiError.js';
import { TESTIMONIAL_ERRORS } from '../messages.js';
import { objectId } from '../services/authorization.js';
import { notify } from '../services/notifications/dispatcher.js';
import type { RequestContext } from '../types/express.js';

const router = Router();

/* -------------------------------------------------------------------------- */
/* Public                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Approved testimonials for one photographer, shown on their public profile.
 *
 * Unauthenticated, and filtered on `approved: true` before anything else runs,
 * so a pending or rejected review can never surface here even by guessing an id.
 */
const publicListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  featuredOnly: z.enum(['true', 'false']).optional(),
});

/**
 * Everything the platform has approved, for the landing page.
 *
 * Declared before `/public/:photographerId` so the literal segment is not
 * captured as a photographer id.
 */
router.get(
  '/public/featured',
  asyncHandler(async (req, res) => {
    const items = await TestimonialModel.find({ approved: true })
      .sort({ featured: -1, createdAt: -1 })
      .limit(12)
      .lean();
    return ok(res, { testimonials: items.map((t) => toPublicDto(t)) });
  }),
);

router.get(
  '/public/:photographerId',
  validateQuery(publicListSchema),
  asyncHandler(async (req, res) => {
    const filters = q<z.infer<typeof publicListSchema>>(req);

    const filter: Record<string, unknown> = {
      photographerId: objectId(req.params.photographerId, 'photographer id'),
      approved: true,
    };
    if (filters.featuredOnly === 'true') filter.featured = true;

    const items = await TestimonialModel.find(filter)
      .sort({ featured: -1, createdAt: -1 })
      .limit(filters.limit)
      .lean();

    const aggregate = await TestimonialModel.aggregate([
      { $match: { photographerId: objectId(req.params.photographerId), approved: true } },
      { $group: { _id: '$rating', count: { $sum: 1 } } },
    ]);

    const breakdown = aggregate.reduce<Record<string, number>>((acc, row) => {
      acc[String(row._id)] = row.count;
      return acc;
    }, {});
    const total = Object.values(breakdown).reduce((sum, count) => sum + count, 0);
    const weighted = Object.entries(breakdown).reduce(
      (sum, [rating, count]) => sum + Number(rating) * count,
      0,
    );

    return ok(res, {
      testimonials: items.map((t) => toPublicDto(t)),
      rating: {
        average: total === 0 ? 0 : Math.round((weighted / total) * 10) / 10,
        count: total,
        breakdown: { 5: breakdown['5'] ?? 0, 4: breakdown['4'] ?? 0, 3: breakdown['3'] ?? 0, 2: breakdown['2'] ?? 0, 1: breakdown['1'] ?? 0 },
      },
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Client: writing one                                                         */
/* -------------------------------------------------------------------------- */

const createSchema = z.object({
  photographerId: z.string().min(1),
  projectId: z.string().optional(),
  rating: z.coerce.number().int().min(1, 'Pick a rating.').max(5),
  title: z.string().trim().max(160).optional(),
  content: z.string().trim().min(10, 'Tell us a little more.').max(3000),
});

/**
 * Write a testimonial.
 *
 * Eligibility is derived from the caller's own bookings, never from a submitted
 * photographer id: the client must have actually worked with this studio.
 * `authorName` and `authorAvatar` are copied from the user record at write time
 * so a later account deletion or rename cannot rewrite published quotes.
 */
router.post(
  '/',
  authenticate,
  requireClient,
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const photographerId = objectId(req.body.photographerId, 'photographer id');

    // Project owns `bookingId`, not the other way round, so the project is looked
    // up through the booking rather than read off the booking.
    let project: {
      _id: Types.ObjectId;
      clientId?: unknown;
      photographerId?: unknown;
      bookingId?: unknown;
    } | null = null;
    let booking = null;
    if (req.body.projectId) {
      project = await ProjectModel.findById(req.body.projectId)
        .select('_id photographerId clientId bookingId')
        .lean();
      if (!project || String(project.clientId) !== String(req.ctx.userId)) {
        throw ApiError.notFound(TESTIMONIAL_ERRORS.notEligible);
      }
      if (String(project.photographerId) !== String(photographerId)) {
        throw ApiError.badRequest(TESTIMONIAL_ERRORS.wrongPhotographer);
      }
      booking = await BookingModel.findOne({
        _id: project.bookingId,
        clientId: req.ctx.userId,
        status: 'completed',
      }).lean();
    } else {
      booking = await BookingModel.findOne({
        clientId: req.ctx.userId,
        photographerId,
        status: 'completed',
      }).lean();
      if (booking) {
        project = await ProjectModel.findOne({ bookingId: booking._id }).select('_id').lean();
      }
    }

    if (!booking) throw ApiError.forbidden(TESTIMONIAL_ERRORS.notEligible);

    const projectId = project?._id ?? null;

    const duplicate = await TestimonialModel.findOne({
      clientId: req.ctx.userId,
      photographerId,
      projectId,
    });
    if (duplicate) throw ApiError.conflict(TESTIMONIAL_ERRORS.duplicate);

    const author = await UserModel.findById(req.ctx.userId).select('name avatar').lean();

    const testimonial = await TestimonialModel.create({
      clientId: req.ctx.userId,
      photographerId,
      projectId,
      bookingId: booking._id,
      rating: req.body.rating,
      title: req.body.title ?? '',
      content: req.body.content,
      authorName: author?.name ?? '',
      authorAvatar: author?.avatar ?? '',
      eventType: booking.eventType,
      requestedAt: booking.reviewedAt,
    });

    await notify({
      userId: photographerId,
      photographerId,
      projectId: testimonial.projectId,
      type: 'testimonial_submitted',
      title: 'New testimonial',
      message: `${author?.name ?? 'A client'} left you a ${req.body.rating}-star review.`,
      link: `/testimonials/${String(testimonial._id)}`,
      priority: 'normal',
    });

    return created(res, { testimonial: toOwnDto(testimonial.toObject()) }, 'Thank you for your review.');
  }),
);

/** What the client has already written, and what they are still able to write. */
router.get(
  '/mine',
  authenticate,
  requireClient,
  asyncHandler(async (req, res) => {
    const written = await TestimonialModel.find({ clientId: req.ctx.userId }).sort({ createdAt: -1 }).lean();

    const eligibleBookings = await BookingModel.find({
      clientId: req.ctx.userId,
      status: 'completed',
    })
      .select('_id photographerId eventType eventDate reviewedAt')
      .sort({ eventDate: -1 })
      .limit(50)
      .lean();

    // The project is keyed by booking, so resolve them in one batch.
    const projects = await ProjectModel.find({ bookingId: { $in: eligibleBookings.map((b) => b._id) } })
      .select('_id bookingId')
      .lean();
    const projectByBooking = new Map(projects.map((p) => [String(p.bookingId), String(p._id)]));

    const writtenProjects = new Set(
      written.filter((t) => t.projectId).map((t) => String(t.projectId)),
    );

    return ok(res, {
      testimonials: written.map((t) => toOwnDto(t)),
      eligible: eligibleBookings
        .map((b) => ({ booking: b, projectId: projectByBooking.get(String(b._id)) ?? null }))
        .filter(({ projectId }) => projectId === null || !writtenProjects.has(projectId))
        .map(({ booking: b, projectId }) => ({
          bookingId: String(b._id),
          photographerId: String(b.photographerId),
          projectId,
          eventType: b.eventType,
          eventDate: b.eventDate,
          requested: Boolean(b.reviewedAt),
        })),
    });
  }),
);

router.patch(
  '/:id',
  authenticate,
  requireClient,
  validateBody(
    z.object({
      rating: z.coerce.number().int().min(1).max(5).optional(),
      title: z.string().trim().max(160).optional(),
      content: z.string().trim().min(10).max(3000).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const testimonial = await assertOwn(req.params.id, req.ctx);
    if (testimonial.approved) {
      throw ApiError.conflict(TESTIMONIAL_ERRORS.alreadyApproved);
    }

    if (req.body.rating !== undefined) testimonial.rating = req.body.rating;
    if (req.body.title !== undefined) testimonial.title = req.body.title;
    if (req.body.content !== undefined) testimonial.content = req.body.content;

    await testimonial.save();
    return ok(res, { testimonial: toOwnDto(testimonial.toObject()) }, 'Review updated.');
  }),
);

router.delete(
  '/:id',
  authenticate,
  requireClient,
  asyncHandler(async (req, res) => {
    const testimonial = await assertOwn(req.params.id, req.ctx);
    await testimonial.deleteOne();
    return noContent(res, 'Review removed.');
  }),
);

/* -------------------------------------------------------------------------- */
/* Photographer: moderation                                                    */
/* -------------------------------------------------------------------------- */

const moderationSchema = z.object({
  pending: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

router.get(
  '/received',
  authenticate,
  requirePhotographer,
  validateQuery(moderationSchema),
  asyncHandler(async (req, res) => {
    const filters = q<z.infer<typeof moderationSchema>>(req);
    const filter: Record<string, unknown> = { photographerId: req.ctx.tenantId };
    if (filters.pending !== undefined) filter.approved = filters.pending !== 'true';

    const items = await TestimonialModel.find(filter).sort({ createdAt: -1 }).limit(filters.limit).lean();
    const pendingCount = await TestimonialModel.countDocuments({ photographerId: req.ctx.tenantId, approved: false });

    return ok(res, {
      testimonials: items.map((t) => ({ ...toPublicDto(t), approved: t.approved, rejectedReason: t.rejectedReason })),
      pending: pendingCount,
    });
  }),
);

router.post(
  '/:id/approve',
  authenticate,
  requirePhotographer,
  asyncHandler(async (req, res) => {
    const testimonial = await assertOwn(req.params.id, req.ctx);
    if (testimonial.approved) throw ApiError.conflict('That review is already live.');

    testimonial.approved = true;
    testimonial.approvedAt = new Date();
    testimonial.rejectedReason = '';
    await testimonial.save();

    await refreshPhotographerRating(testimonial.photographerId);

    await notify({
      userId: testimonial.clientId,
      photographerId: testimonial.photographerId,
      projectId: testimonial.projectId,
      type: 'testimonial_submitted',
      title: 'Your review is live',
      message: `${testimonial.authorName || 'Your review'} has been published on the studio profile.`,
      link: `/photographers`,
      priority: 'low',
    });

    return ok(res, { testimonial: toPublicDto(testimonial.toObject()) }, 'Review published.');
  }),
);

router.post(
  '/:id/reject',
  authenticate,
  requirePhotographer,
  validateBody(z.object({ reason: z.string().trim().max(400).optional() })),
  asyncHandler(async (req, res) => {
    const testimonial = await assertOwn(req.params.id, req.ctx);
    if (testimonial.approved) throw ApiError.conflict(TESTIMONIAL_ERRORS.alreadyApproved);

    testimonial.approved = false;
    testimonial.rejectedReason = req.body.reason ?? '';
    await testimonial.save();

    await notify({
      userId: testimonial.clientId,
      photographerId: testimonial.photographerId,
      projectId: testimonial.projectId,
      type: 'testimonial_submitted',
      title: 'About your review',
      message: 'The photographer has not published your review yet.',
      link: '/testimonials',
      priority: 'low',
    });

    return ok(res, { testimonial: toOwnDto(testimonial.toObject()) }, 'Review not published.');
  }),
);

/** Ask a past client for a review. */
router.post(
  '/request',
  authenticate,
  requirePhotographer,
  validateBody(
    z.object({
      clientIds: z.array(z.string()).min(1, 'Pick at least one client.').max(50),
      message: z.string().trim().max(500).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const clientIds = (req.body.clientIds as string[]).map((id) => objectId(id, 'client id'));

    // Only clients who actually completed work with this studio.
    const valid = await BookingModel.distinct('clientId', {
      photographerId: req.ctx.tenantId,
      clientId: { $in: clientIds },
      status: 'completed',
    });

    // Map each eligible client to their most recent completed booking's project.
    const projects = await ProjectModel.find({
      photographerId: req.ctx.tenantId,
      clientId: { $in: valid },
    })
      .select('_id clientId createdAt')
      .sort({ createdAt: -1 })
      .lean();
    const projectByClient = new Map<string, Types.ObjectId>();
    for (const project of projects) {
      const key = String(project.clientId);
      if (!projectByClient.has(key)) projectByClient.set(key, project._id);
    }

    for (const clientId of valid) {
      await notify({
        userId: clientId,
        photographerId: req.ctx.tenantId,
        projectId: projectByClient.get(String(clientId)) ?? null,
        type: 'testimonial_requested',
        title: 'How was it?',
        message: req.body.message ?? 'We would love to hear about your experience.',
        link: '/testimonials/new',
        priority: 'low',
        email: true,
      });
    }

    return ok(res, { sent: valid.length, skipped: clientIds.length - valid.length }, 'Review requests sent.');
  }),
);

/** Curate which reviews lead the public profile. */
router.put(
  '/featured',
  authenticate,
  requirePhotographer,
  validateBody(z.object({ testimonialIds: z.array(z.string()).min(1).max(12) })),
  asyncHandler(async (req, res) => {
    const ids = (req.body.testimonialIds as string[]).map((id) => objectId(id, 'testimonial id'));
    const owned = await TestimonialModel.countDocuments({
      _id: { $in: ids },
      photographerId: req.ctx.tenantId,
      approved: true,
    });
    if (owned !== ids.length) throw ApiError.badRequest('One or more reviews are not yours to feature.');

    await TestimonialModel.updateMany(
      { photographerId: req.ctx.tenantId, _id: { $nin: ids } },
      { $set: { featured: false } },
    );
    await TestimonialModel.bulkWrite(
      ids.map((id, index) => ({
        updateOne: { filter: { _id: id }, update: { $set: { featured: true, sortOrder: index } } },
      })),
    );

    return ok(res, { featured: ids.length }, 'Featured reviews updated.');
  }),
);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

type TestimonialShape = {
  _id: unknown;
  photographerId: unknown;
  projectId?: unknown;
  rating: number;
  title: string;
  content: string;
  authorName: string;
  authorAvatar: string;
  eventType: string;
  approved: boolean;
  approvedAt?: Date | null;
  rejectedReason: string;
  featured: boolean;
  createdAt: Date;
};

/** Public shape: identity is the frozen author fields, never a live user join. */
function toPublicDto(t: TestimonialShape) {
  return {
    id: String(t._id),
    photographerId: String(t.photographerId),
    projectId: t.projectId ? String(t.projectId) : null,
    rating: t.rating,
    title: t.title,
    content: t.content,
    authorName: t.authorName,
    authorAvatar: t.authorAvatar,
    eventType: t.eventType,
    featured: t.featured,
    createdAt: t.createdAt,
  };
}

/** The author's own view includes the moderation state so the UI can explain it. */
function toOwnDto(t: TestimonialShape) {
  return {
    ...toPublicDto(t),
    approved: t.approved,
    approvedAt: t.approvedAt,
    rejectedReason: t.rejectedReason,
  };
}

async function assertOwn(id: string, ctx: RequestContext) {
  const testimonial = await TestimonialModel.findById(objectId(id, 'testimonial id'));
  if (!testimonial) throw ApiError.notFound(TESTIMONIAL_ERRORS.notFound);

  const isAuthor = String(testimonial.clientId) === String(ctx.userId);
  const isOwner = String(testimonial.photographerId) === String(ctx.tenantId);
  if (!isAuthor && !isOwner) throw ApiError.notFound(TESTIMONIAL_ERRORS.notFound);

  return testimonial;
}

/**
 * Keep the denormalised rating on the profile in step with approved reviews.
 * Recomputed rather than incremented so a rejected review cannot leave the
 * average permanently skewed.
 */
async function refreshPhotographerRating(photographerId: Types.ObjectId): Promise<void> {
  const rows = await TestimonialModel.aggregate([
    { $match: { photographerId, approved: true } },
    { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);

  await PhotographerProfileModel.updateOne(
    { userId: photographerId },
    {
      $set: {
        'rating.average': rows[0] ? Math.round(rows[0].average * 10) / 10 : 0,
        'rating.count': rows[0]?.count ?? 0,
      },
    },
  );
}

export default router;
