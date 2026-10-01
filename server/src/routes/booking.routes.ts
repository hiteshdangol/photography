import { Router } from 'express';
import type { Types } from 'mongoose';
import { Types as MongooseTypes } from 'mongoose';
import { z } from 'zod';
import type { HydratedDocument } from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created } from '../utils/response.js';
import { BookingModel, PackageModel, ProjectModel, UserModel, type Booking } from '../models/index.js';
import { authenticate, requireClient, requirePhotographer } from '../middleware/auth.js';
import { validateBody, validateQuery, q } from '../middleware/validate.js';
import { ApiError } from '../utils/ApiError.js';
import { BOOKING_ERRORS } from '../messages.js';
import { assertAdminAudit, objectId } from '../services/authorization.js';
import { assertBookable } from '../services/availability.js';
import { advance } from '../services/timeline/engine.js';
import { notify } from '../services/notifications/dispatcher.js';
import { computeDeposit, toMinor, type DepositType } from '../utils/money.js';
import { shortCode } from '../utils/crypto.js';
import { slugify, uniqueSlug } from '../utils/slug.js';

const router = Router();

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

/* -------------------------------------------------------------------------- */
/* Public booking request                                                      */
/* -------------------------------------------------------------------------- */

const requestSchema = z.object({
  photographerId: z.string().min(1),
  packageId: z.string().optional(),
  eventType: z.string().trim().min(2, 'Tell us what kind of shoot this is.').max(80),
  eventDate: z.coerce.date(),
  startTime: z.string().regex(timePattern, 'Choose a start time.'),
  endTime: z.string().regex(timePattern, 'Choose an end time.'),
  location: z.string().trim().min(2, 'Where is the shoot?').max(240),
  guestCount: z.coerce.number().int().min(0).max(100000).optional(),
  notes: z.string().trim().max(4000).optional(),
  additionalServiceName: z.string().trim().max(200).optional(),
  additionalServicePrice: z.coerce.number().min(0).optional(),
});

/**
 * The client-facing "Request a booking" flow.
 *
 * Authenticated clients only: a booking is tied to a real account so the client
 * can pay for it, message the photographer and see the timeline. There is no
 * anonymous booking.
 *
 * Availability is re-checked here (not just in the calendar UI) and a price
 * snapshot is frozen at request time.
 */
router.post(
  '/request',
  authenticate,
  requireClient,
  validateBody(requestSchema),
  asyncHandler(async (req, res) => {
    const photographerId = objectId(req.body.photographerId, 'photographer id');
    const photographer = await UserModel.findOne({
      _id: photographerId,
      role: 'photographer',
      status: 'active',
    })
      .select('_id')
      .lean();
    if (!photographer) throw ApiError.notFound('That photographer is not available.');

    if (req.body.endTime <= req.body.startTime) {
      throw ApiError.validation('Please check the highlighted fields.', [
        { field: 'endTime', message: 'The end time must be after the start time.' },
      ]);
    }
    if (req.body.eventDate.getTime() < Date.now() - 24 * 60 * 60 * 1000) {
      throw ApiError.badRequest('Choose a date in the future.');
    }

    // The authoritative availability check. A client that skipped the calendar
    // entirely still cannot book a slot that is taken.
    await assertBookable(photographerId, req.body.eventDate, req.body.startTime, req.body.endTime);

    // Freeze the price from the photographer's live package. The deposit type is
    // narrowed explicitly so a widened `string` cannot reach computeDeposit.
    let snapshot: {
      packageName: string;
      totalMinor: number;
      currency: string;
      depositType: DepositType;
      depositValue: number;
      depositMinor: number;
    } = {
      packageName: 'Custom shoot',
      totalMinor: 0,
      currency: 'NPR',
      depositType: 'percent',
      depositValue: 0,
      depositMinor: 0,
    };

    if (req.body.packageId) {
      const pkg = await PackageModel.findOne({
        _id: objectId(req.body.packageId, 'package id'),
        photographerId,
        active: true,
      }).lean();
      if (pkg) {
        snapshot = {
          packageName: pkg.name,
          totalMinor: pkg.priceMinor,
          currency: pkg.currency,
          depositType: pkg.depositType,
          depositValue: pkg.depositValue,
          depositMinor: pkg.depositMinor,
        };
      }
    }

    const additionalMinor = req.body.additionalServicePrice
      ? toMinor(req.body.additionalServicePrice)
      : 0;
    snapshot.totalMinor += additionalMinor;
    // Recompute the deposit against the final total, including extras.
    snapshot.depositMinor = computeDeposit(
      snapshot.totalMinor,
      snapshot.depositType,
      snapshot.depositValue,
    );

    const durationHours =
      (toMinutes(req.body.endTime) - toMinutes(req.body.startTime)) / 60;

    const booking = await BookingModel.create({
      reference: `LF-BK-${shortCode(6)}`,
      photographerId,
      clientId: req.ctx.userId,
      packageId: req.body.packageId ? objectId(req.body.packageId) : null,
      eventType: req.body.eventType,
      eventDate: req.body.eventDate,
      startTime: req.body.startTime,
      endTime: req.body.endTime,
      durationHours: Number(durationHours.toFixed(2)),
      location: req.body.location,
      guestCount: req.body.guestCount ?? null,
      priceSnapshot: snapshot,
      additionalServices: {
        name: req.body.additionalServiceName ?? '',
        price: req.body.additionalServicePrice ?? 0,
        priceMinor: additionalMinor,
      },
      notes: req.body.notes ?? '',
      status: 'pending',
      paymentStatus: 'unpaid',
      paidMinor: 0,
      balanceMinor: snapshot.totalMinor,
      conflictCheckedAt: new Date(),
    });

    await notify({
      userId: photographerId,
      type: 'booking_requested',
      title: 'New booking request',
      message: `${req.ctx.email} requested ${req.body.eventType} on ${req.body.eventDate.toDateString()}.`,
      link: `/dashboard/bookings/${String(booking._id)}`,
      bookingId: booking._id,
      priority: 'high',
      email: true,
    });

    await notify({
      userId: req.ctx.userId,
      photographerId,
      type: 'booking_requested',
      title: 'Booking request sent',
      message: 'Your request has been sent. You will be notified when it is reviewed.',
      link: `/dashboard/bookings/${String(booking._id)}`,
      bookingId: booking._id,
    });

    return created(res, { booking }, 'Booking request sent.');
  }),
);

/* -------------------------------------------------------------------------- */
/* Lists                                                                       */
/* -------------------------------------------------------------------------- */

const listSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'completed']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/**
 * One list for both roles. The scope is decided by the verified role, never by a
 * query parameter, so a client cannot ask for another tenant's bookings.
 */
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
    if (filters.status) filter.status = filters.status;
    if (filters.from || filters.to) {
      filter.eventDate = {
        ...(filters.from ? { $gte: filters.from } : {}),
        ...(filters.to ? { $lte: filters.to } : {}),
      };
    }

    const [items, total, counts] = await Promise.all([
      BookingModel.find(filter)
        .sort({ eventDate: 1 })
        .skip(pagination.skip)
        .limit(pagination.limit)
        .populate('clientId', 'name email phone avatar')
        .lean(),
      BookingModel.countDocuments(filter),
      BookingModel.aggregate([
        { $match: filter },
        { $group: { _id: '$status', count: { $sum: 1 }, revenue: { $sum: '$priceSnapshot.totalMinor' } } },
      ]),
    ]);

    return ok(res, {
      bookings: items,
      pagination: {
        ...pagination,
        total,
        totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
      },
      summary: counts.map((c) => ({ status: c._id, count: c.count, revenueMinor: c.revenue })),
    });
  }),
);

const calendarSchema = listSchema.pick({ from: true, to: true });

/** Bookings as calendar events, for the FullCalendar grid and the month view. */
router.get(
  '/calendar',
  authenticate,
  validateQuery(calendarSchema),
  asyncHandler(async (req, res) => {
    const filters = q<z.infer<typeof calendarSchema>>(req);
    const filter: Record<string, unknown> =
      req.ctx.role === 'client' ? { clientId: req.ctx.userId } : { photographerId: req.ctx.tenantId };
    filter.eventDate = {
      $gte: filters.from ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      $lte: filters.to ?? new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
    };

    const bookings = await BookingModel.find(filter)
      .select('reference eventType eventDate startTime endTime location status paymentStatus priceSnapshot')
      .sort({ eventDate: 1 })
      .limit(1000)
      .lean();

    return ok(res, {
      events: bookings.map((b) => ({
        id: String(b._id),
        title: `${b.eventType} (${b.startTime}-${b.endTime})`,
        start: `${b.eventDate.toISOString().slice(0, 10)}T${b.startTime}:00`,
        end: `${b.eventDate.toISOString().slice(0, 10)}T${b.endTime}:00`,
        extendedProps: {
          reference: b.reference,
          location: b.location,
          status: b.status,
          paymentStatus: b.paymentStatus,
        },
      })),
    });
  }),
);

router.get(
  '/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    const booking = await loadBooking(req.params.id, req.ctx);
    const project = await ProjectModel.findOne({ bookingId: booking._id }).select('_id timelineStage').lean();
    return ok(res, { booking, project: project ?? null });
  }),
);

/* -------------------------------------------------------------------------- */
/* Photographer decisions                                                      */
/* -------------------------------------------------------------------------- */

const decisionSchema = z.object({
  reason: z.string().trim().max(600).optional(),
});

/**
 * Approve a request.
 *
 * Approval creates the project (if there isn't one yet) and advances the
 * timeline. Availability is re-checked first, because the slot may have been
 * taken by another pending request while this one waited.
 */
router.post(
  '/:id/approve',
  authenticate,
  requirePhotographer,
  validateBody(decisionSchema),
  asyncHandler(async (req, res) => {
    const booking = await loadBooking(req.params.id, req.ctx);
    if (booking.status !== 'pending') {
      throw ApiError.conflict(BOOKING_ERRORS.alreadyReviewed);
    }

    await assertBookable(
      booking.photographerId,
      booking.eventDate,
      booking.startTime,
      booking.endTime,
      { ignoreBookingId: String(booking._id) },
    );

    booking.status = 'approved';
    booking.reviewedAt = new Date();
    booking.reviewedBy = req.ctx.userId;
    await booking.save();

    const project = await ensureProject(booking);
    await advance({
      projectId: project._id,
      trigger: 'BOOKING_APPROVED',
      actorId: req.ctx.userId,
      description: 'Booking approved by the photographer.',
    });

    await notify({
      userId: booking.clientId,
      photographerId: booking.photographerId,
      type: 'booking_approved',
      title: 'Your booking is confirmed',
      message: `We are looking forward to your ${booking.eventType} on ${booking.eventDate.toDateString()}.`,
      link: `/projects/${String(project._id)}`,
      bookingId: booking._id,
      projectId: project._id,
      priority: 'high',
      email: true,
    });

    return ok(res, { booking, project }, 'Booking approved.');
  }),
);

router.post(
  '/:id/reject',
  authenticate,
  requirePhotographer,
  validateBody(decisionSchema.extend({ reason: z.string().trim().min(4, 'Please tell the client why.').max(600) })),
  asyncHandler(async (req, res) => {
    const booking = await loadBooking(req.params.id, req.ctx);
    if (booking.status !== 'pending') throw ApiError.conflict(BOOKING_ERRORS.alreadyReviewed);

    booking.status = 'rejected';
    booking.rejectionReason = req.body.reason;
    booking.reviewedAt = new Date();
    booking.reviewedBy = req.ctx.userId;
    await booking.save();

    await notify({
      userId: booking.clientId,
      photographerId: booking.photographerId,
      type: 'booking_rejected',
      title: 'Booking request declined',
      message: req.body.reason,
      link: '/dashboard/bookings',
      bookingId: booking._id,
      email: true,
    });

    return ok(res, { booking }, 'Booking declined.');
  }),
);

/* -------------------------------------------------------------------------- */
/* Cancellation and rescheduling                                               */
/* -------------------------------------------------------------------------- */

const cancelSchema = z.object({
  reason: z.string().trim().max(600).optional(),
});

router.post(
  '/:id/cancel',
  authenticate,
  validateBody(cancelSchema),
  asyncHandler(async (req, res) => {
    const booking = await loadBooking(req.params.id, req.ctx);
    if (['cancelled', 'completed', 'rejected'].includes(booking.status)) {
      throw ApiError.conflict(BOOKING_ERRORS.cannotEdit);
    }

    booking.status = 'cancelled';
    booking.cancelledAt = new Date();
    booking.cancelledBy = req.ctx.userId;
    booking.cancellationReason = req.body.reason ?? '';
    await booking.save();

    const project = await ProjectModel.findOne({ bookingId: booking._id });
    if (project) {
      project.status = 'cancelled';
      await project.save();
    }

    const recipient =
      String(booking.photographerId) === String(req.ctx.userId) ? booking.clientId : booking.photographerId;
    await notify({
      userId: recipient,
      photographerId: booking.photographerId,
      type: 'booking_cancelled',
      title: 'Booking cancelled',
      message: req.body.reason
        ? `A booking was cancelled: ${req.body.reason}`
        : 'A booking was cancelled.',
      link: '/dashboard/bookings',
      bookingId: booking._id,
      email: true,
    });

    return ok(res, { booking }, 'Booking cancelled.');
  }),
);

const rescheduleSchema = z.object({
  eventDate: z.coerce.date(),
  startTime: z.string().regex(timePattern),
  endTime: z.string().regex(timePattern),
  reason: z.string().trim().max(600).optional(),
});

/**
 * Rescheduling always goes back through the availability check, so a move cannot
 * create a double booking.
 */
router.post(
  '/:id/reschedule',
  authenticate,
  validateBody(rescheduleSchema),
  asyncHandler(async (req, res) => {
    const booking = await loadBooking(req.params.id, req.ctx);
    if (['cancelled', 'completed', 'rejected'].includes(booking.status)) {
      throw ApiError.conflict(BOOKING_ERRORS.cannotEdit);
    }
    if (req.body.endTime <= req.body.startTime) {
      throw ApiError.validation('Please check the highlighted fields.', [
        { field: 'endTime', message: 'The end time must be after the start time.' },
      ]);
    }

    await assertBookable(
      booking.photographerId,
      req.body.eventDate,
      req.body.startTime,
      req.body.endTime,
      { ignoreBookingId: String(booking._id) },
    );

    booking.eventDate = req.body.eventDate;
    booking.startTime = req.body.startTime;
    booking.endTime = req.body.endTime;
    booking.durationHours = Number(((toMinutes(req.body.endTime) - toMinutes(req.body.startTime)) / 60).toFixed(2));
    booking.conflictCheckedAt = new Date();
    booking.notes = booking.notes ? `${booking.notes}\n[Rescheduled] ${req.body.reason ?? ''}`.trim() : booking.notes;
    await booking.save();

    const project = await ProjectModel.findOne({ bookingId: booking._id });
    if (project) {
      project.eventDate = req.body.eventDate;
      await project.save();
    }

    const recipient =
      String(booking.photographerId) === String(req.ctx.userId) ? booking.clientId : booking.photographerId;
    await notify({
      userId: recipient,
      photographerId: booking.photographerId,
      type: 'timeline_updated',
      title: 'Booking rescheduled',
      message: `Your booking has moved to ${req.body.eventDate.toDateString()}, ${req.body.startTime}-${req.body.endTime}.`,
      link: '/dashboard/bookings',
      bookingId: booking._id,
      email: true,
    });

    return ok(res, { booking }, 'Booking rescheduled.');
  }),
);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Loads a booking the caller is allowed to see, or 404s. */
async function loadBooking(id: string, ctx: Express.Request['ctx']) {
  const booking = await BookingModel.findById(objectId(id, 'booking id'));
  if (!booking) throw ApiError.notFound(BOOKING_ERRORS.notFound);

  if (ctx.role === 'client' && String(booking.clientId) !== String(ctx.userId)) {
    throw ApiError.notFound(BOOKING_ERRORS.notFound);
  }
  if (ctx.role === 'photographer' && String(booking.photographerId) !== String(ctx.tenantId)) {
    throw ApiError.notFound(BOOKING_ERRORS.notFound);
  }
  if (ctx.role === 'superadmin') {
    // A superadmin can see that a booking exists, but must justify it.
    await assertAdminAudit(ctx, { adminAudit: 'platform support review' }, {
      targetType: 'Booking',
      targetId: booking._id,
      tenantId: booking.photographerId as Types.ObjectId,
    });
  }
  return booking;
}

/** One project per booking, created on demand. */
async function ensureProject(booking: HydratedDocument<Booking>) {
  const existing = await ProjectModel.findOne({ bookingId: booking._id });
  if (existing) return existing;

  const slug = await uniqueSlug(
    slugify(`${booking.eventType}-${booking.clientId}`),
    async (candidate) => Boolean(await ProjectModel.findOne({ slug: candidate }).select('_id').lean()),
  );

  return ProjectModel.create({
    photographerId: booking.photographerId,
    clientId: booking.clientId,
    bookingId: booking._id,
    title: `${booking.eventType} - ${booking.eventDate.toDateString()}`,
    slug,
    description: booking.notes ?? '',
    eventDate: booking.eventDate,
    location: booking.location,
    eventType: booking.eventType,
    status: 'confirmed',
    timelineStage: 'booking_requested',
    totalMinor: booking.priceSnapshot?.totalMinor ?? 0,
    currency: booking.priceSnapshot?.currency ?? 'NPR',
  });
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export default router;
