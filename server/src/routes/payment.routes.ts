import { Router } from 'express';
import type { Types } from 'mongoose';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created } from '../utils/response.js';
import { BookingModel, InvoiceModel, PaymentModel, ProjectModel } from '../models/index.js';
import { authenticate } from '../middleware/auth.js';
import { validateBody, validateQuery, q } from '../middleware/validate.js';
import { ApiError } from '../utils/ApiError.js';
import { PAYMENT_ERRORS } from '../messages.js';
import { objectId } from '../services/authorization.js';
import { paymentLimiter } from '../middleware/rateLimit.js';
import { availableProviders } from '../services/payments/providers.js';
import {
  createSession,
  recordManualPayment,
  verifyPayment,
} from '../services/payments/payment.service.js';
import { notify } from '../services/notifications/dispatcher.js';
import { adminAudit } from '../services/admin.service.js';

const router = Router();

/* -------------------------------------------------------------------------- */
/* Discovery                                                                   */
/* -------------------------------------------------------------------------- */

/** Which gateways are usable right now, so the client only offers real ones. */
router.get(
  '/providers',
  asyncHandler(async (_req, res) => {
    return ok(res, { providers: availableProviders() });
  }),
);

/* -------------------------------------------------------------------------- */
/* Session creation                                                            */
/* -------------------------------------------------------------------------- */

const sessionSchema = z.object({
  bookingId: z.string().min(1, 'A booking is required.'),
  paymentType: z.enum(['deposit', 'balance', 'full']).default('deposit'),
  provider: z.enum(['mock', 'esewa', 'khalti']).optional(),
  /**
   * Client-generated key. Retrying "Pay now" with the same key returns the same
   * session instead of creating a second charge.
   */
  idempotencyKey: z.string().trim().max(80).optional(),
});

/** Only the client who owns the booking may start a payment for it. */
router.post(
  '/session',
  authenticate,
  paymentLimiter,
  validateBody(sessionSchema),
  asyncHandler(async (req, res) => {
    const bookingId = objectId(req.body.bookingId, 'booking id');
    const booking = await BookingModel.findById(bookingId).select('clientId status paymentStatus').lean();
    if (!booking) throw ApiError.notFound(PAYMENT_ERRORS.notFound);
    if (String(booking.clientId) !== String(req.ctx.userId)) {
      throw ApiError.forbidden('You can only pay for your own booking.');
    }

    const session = await createSession({
      bookingId,
      paymentType: req.body.paymentType,
      provider: req.body.provider ?? null,
      idempotencyKey: req.body.idempotencyKey,
    });

    return created(res, session, 'Payment session created.');
  }),
);

/* -------------------------------------------------------------------------- */
/* Verification                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The return endpoint.
 *
 * A gateway redirect lands here with whatever query parameters it likes. They
 * are only used to *find* the payment: the money is confirmed by the outbound
 * verification call inside `verifyPayment`, never by the parameters themselves.
 */
router.get(
  '/callback/:provider',
  paymentLimiter,
  asyncHandler(async (req, res) => {
    const providerName = req.params.provider;
    const query = z
      .object({
        txn: z.string().optional(),
        transaction_uuid: z.string().optional(),
        pidx: z.string().optional(),
        pid: z.string().optional(),
        ref: z.string().optional(),
        r: z.string().optional(),
      })
      .parse(req.query);

    const transactionId = query.txn ?? query.transaction_uuid ?? query.pidx;
    const reference = query.ref ?? query.r ?? query.pid;

    if (!transactionId && !reference) {
      throw ApiError.badRequest('The gateway did not return a usable reference.');
    }

    // Prefer matching on the gateway transaction id; fall back to our reference.
    const payment = await PaymentModel.findOne({
      $or: [
        ...(transactionId ? [{ transactionId }] : []),
        ...(reference ? [{ merchantReference: reference }, { reference }] : []),
      ],
    });
    if (!payment) throw ApiError.notFound(PAYMENT_ERRORS.notFound);

    const outcome = await verifyPayment(String(payment._id));
    const clientUrl = process.env.CLIENT_URL ?? 'http://localhost:5173';

    // The browser is always returned to the SPA; the result is rendered there.
    const status = outcome.verified ? 'success' : 'failed';
    return res.redirect(
      `${clientUrl}/payments/${payment.reference}?status=${status}&provider=${encodeURIComponent(providerName)}`,
    );
  }),
);

/** Explicit verification, for the SPA to poll after the gateway redirect. */
router.post(
  '/:id/verify',
  authenticate,
  paymentLimiter,
  asyncHandler(async (req, res) => {
    const paymentId = objectId(req.params.id, 'payment id');
    const payment = await PaymentModel.findById(paymentId).select('clientId').lean();
    if (!payment) throw ApiError.notFound(PAYMENT_ERRORS.notFound);
    if (String(payment.clientId) !== String(req.ctx.userId) && req.ctx.role !== 'photographer') {
      throw ApiError.forbidden('You cannot verify this payment.');
    }

    const outcome = await verifyPayment(String(paymentId));
    return ok(res, outcome, outcome.verified ? 'Payment confirmed.' : 'Payment is not confirmed yet.');
  }),
);

/* -------------------------------------------------------------------------- */
/* History                                                                     */
/* -------------------------------------------------------------------------- */

const listSchema = z.object({
  bookingId: z.string().optional(),
  status: z.enum(['created', 'pending', 'completed', 'failed', 'expired', 'refunded']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
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
    if (filters.bookingId) filter.bookingId = objectId(filters.bookingId, 'booking id');
    if (filters.status) filter.status = filters.status;

    const [items, total] = await Promise.all([
      PaymentModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit)
        .lean(),
      PaymentModel.countDocuments(filter),
    ]);

    return ok(res, {
      payments: items.map((p) => ({
        ...p,
        id: String(p._id),
        // The raw gateway payload is for disputes and support, not the client UI.
        verifiedPayload: req.ctx.role === 'client' ? undefined : p.verifiedPayload,
      })),
      pagination: {
        ...pagination,
        total,
        totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
      },
    });
  }),
);

router.get(
  '/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    const payment = await PaymentModel.findById(objectId(req.params.id, 'payment id')).lean();
    if (!payment) throw ApiError.notFound(PAYMENT_ERRORS.notFound);
    if (!canViewPayment(req.ctx.role, req.ctx.userId, req.ctx.tenantId, payment)) {
      throw ApiError.forbidden('You cannot view this payment.');
    }
    return ok(res, {
      payment: {
        ...payment,
        id: String(payment._id),
        verifiedPayload: req.ctx.role === 'client' ? undefined : payment.verifiedPayload,
      },
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Photographer-side: manual payments and refunds                              */
/* -------------------------------------------------------------------------- */

const manualSchema = z.object({
  bookingId: z.string().min(1),
  amount: z.number().positive('Enter an amount greater than zero.'),
  note: z.string().trim().max(400).optional(),
});

/**
 * Cash or bank transfer. The photographer records it; it still flows through the
 * same `applySuccessfulPayment` bookkeeping, so the client sees the same state
 * change they would from a gateway payment.
 */
router.post(
  '/manual',
  authenticate,
  paymentLimiter,
  validateBody(manualSchema),
  asyncHandler(async (req, res) => {
    if (req.ctx.role !== 'photographer') {
      throw ApiError.forbidden('Only the photographer can record a manual payment.');
    }
    const bookingId = objectId(req.body.bookingId, 'booking id');
    const booking = await BookingModel.findById(bookingId).select('photographerId').lean();
    if (!booking) throw ApiError.notFound(PAYMENT_ERRORS.notFound);
    if (String(booking.photographerId) !== String(req.ctx.tenantId)) {
      throw ApiError.forbidden('That booking belongs to another studio.');
    }

    const outcome = await recordManualPayment({
      bookingId,
      amountMinor: Math.round(req.body.amount * 100),
      note: req.body.note,
      actorId: req.ctx.userId,
    });
    return created(res, outcome, 'Payment recorded.');
  }),
);

const refundRequestSchema = z.object({
  reason: z.string().trim().min(4, 'Tell us why the refund is needed.').max(600),
});

/**
 * Refunds are always a two-step flow: the photographer requests, then an admin
 * processes. Nothing is ever refunded automatically.
 */
router.post(
  '/:id/refund/request',
  authenticate,
  validateBody(refundRequestSchema),
  asyncHandler(async (req, res) => {
    if (req.ctx.role !== 'photographer') {
      throw ApiError.forbidden('Only the photographer can request a refund.');
    }
    const payment = await PaymentModel.findById(objectId(req.params.id, 'payment id'));
    if (!payment) throw ApiError.notFound(PAYMENT_ERRORS.notFound);
    if (String(payment.photographerId) !== String(req.ctx.tenantId)) {
      throw ApiError.forbidden('That payment belongs to another studio.');
    }
    if (payment.status !== 'completed') {
      throw ApiError.badRequest('Only a completed payment can be refunded.');
    }
    if (payment.refund.status !== 'not_requested' && payment.refund.status !== 'cancelled') {
      throw ApiError.conflict('A refund has already been requested for this payment.');
    }

    // The refund lifecycle lives entirely on `refund.status`. `payment.status`
    // stays `completed` because the money did arrive; flipping it to a
    // not-in-enum `refund_pending` would both fail validation and hide the
    // payment from the photographer's revenue totals.
    payment.refund.status = 'requested';
    payment.refund.reason = req.body.reason;
    payment.refund.amountMinor = payment.amountMinor;
    payment.refund.requestedAt = new Date();
    payment.refund.requestedBy = req.ctx.userId;
    await payment.save();

    await notify({
      userId: payment.photographerId,
      photographerId: payment.photographerId,
      paymentId: payment._id,
      bookingId: payment.bookingId,
      type: 'refund_pending',
      title: 'Refund awaiting review',
      message: `A refund of ${(payment.amountMinor / 100).toFixed(2)} was requested.`,
      link: '/dashboard/payments',
      priority: 'high',
    });

    return ok(res, { refund: payment.refund }, 'Refund requested. Our team will review it shortly.');
  }),
);

const refundProcessSchema = z.object({
  action: z.enum(['complete', 'fail', 'cancel']),
  reason: z.string().trim().max(600).optional(),
  providerRefundId: z.string().trim().max(120).optional(),
});

router.post(
  '/:id/refund/process',
  authenticate,
  validateBody(refundProcessSchema),
  asyncHandler(async (req, res) => {
    if (req.ctx.role !== 'superadmin') {
      throw ApiError.forbidden('Only a platform administrator can process a refund.');
    }
    const payment = await PaymentModel.findById(objectId(req.params.id, 'payment id'));
    if (!payment) throw ApiError.notFound(PAYMENT_ERRORS.notFound);
    if (payment.refund.status !== 'requested' && payment.refund.status !== 'processing') {
      throw ApiError.conflict('There is no pending refund on this payment.');
    }

    if (req.body.action === 'complete') {
      payment.refund.status = 'completed';
      payment.refund.processedAt = new Date();
      payment.refund.processedBy = req.ctx.userId;
      payment.refund.providerRefundId = req.body.providerRefundId ?? '';
      payment.status = 'refunded';

      const booking = await BookingModel.findById(payment.bookingId);
      if (booking) {
        booking.paidMinor = Math.max(0, (booking.paidMinor ?? 0) - payment.amountMinor);
        const total = booking.priceSnapshot?.totalMinor ?? 0;
        booking.balanceMinor = Math.max(0, total - booking.paidMinor);
        booking.paymentStatus =
          booking.paidMinor <= 0 ? 'refunded' : booking.paidMinor >= total ? 'paid' : 'partially_paid';
        await booking.save();
      }

      const invoice = payment.invoiceId ? await InvoiceModel.findById(payment.invoiceId) : null;
      if (invoice) {
        invoice.paidMinor = Math.max(0, (invoice.paidMinor ?? 0) - payment.amountMinor);
        invoice.remainingMinor = Math.max(0, invoice.totalMinor - invoice.paidMinor);
        invoice.status =
          invoice.remainingMinor <= 0 ? 'paid' : invoice.paidMinor > 0 ? 'partially_paid' : 'unpaid';
        if (invoice.paidAt && invoice.remainingMinor > 0) invoice.paidAt = null;
        await invoice.save();
      }
    } else if (req.body.action === 'fail') {
      payment.refund.status = 'failed';
      payment.refund.failureReason = req.body.reason ?? 'Refund could not be processed.';
      payment.status = 'completed';
    } else {
      payment.refund.status = 'cancelled';
      payment.status = 'completed';
    }

    payment.refund.processedAt = new Date();
    payment.refund.processedBy = req.ctx.userId;
    await payment.save();

    await adminAudit(req, `refund.${req.body.action}`, 'Payment', payment._id, {
      reason: req.body.reason,
      metadata: { amountMinor: payment.amountMinor },
    });

    await notify({
      userId: payment.clientId,
      photographerId: payment.photographerId,
      paymentId: payment._id,
      type: req.body.action === 'complete' ? 'refund_completed' : 'refund_pending',
      title: req.body.action === 'complete' ? 'Refund processed' : 'Refund update',
      message:
        req.body.action === 'complete'
          ? `A refund of ${(payment.amountMinor / 100).toFixed(2)} has been sent to your original payment method.`
          : `There is an update on your refund request${req.body.reason ? `: ${req.body.reason}` : '.'}`,
      link: '/dashboard/payments',
      email: req.body.action === 'complete',
    });

    return ok(res, { refund: payment.refund, status: payment.status }, 'Refund updated.');
  }),
);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function canViewPayment(
  role: string,
  userId: Types.ObjectId,
  tenantId: Types.ObjectId | null,
  payment: { clientId: Types.ObjectId; photographerId: Types.ObjectId },
): boolean {
  if (role === 'superadmin') return true;
  if (role === 'client') return String(payment.clientId) === String(userId);
  return tenantId !== null && String(payment.photographerId) === String(tenantId);
}

export default router;
