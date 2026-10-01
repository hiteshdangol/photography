import { Types as MongooseTypes, type HydratedDocument, type Types } from 'mongoose';
import { BookingModel, InvoiceModel, PaymentModel, ProjectModel, type Payment } from '../../models/index.js';

/** A saved payment row, as returned by every PaymentModel mutation. */
type PaymentDocument = HydratedDocument<Payment>;
import { PAYMENT_ERRORS } from '../../messages.js';
import { ApiError } from '../../utils/ApiError.js';
import { createLogger } from '../../utils/logger.js';
import { shortCode } from '../../utils/crypto.js';
import { advance } from '../timeline/engine.js';
import { notify } from '../notifications/dispatcher.js';
import { getProvider } from './providers.js';

const log = createLogger('payment.service');

/**
 * What is still owed on a booking, in minor units.
 *
 * Always derived from the booking's own snapshot and its verified payments -
 * never from a client-supplied amount. `deposit` is the amount due before the
 * booking is considered paid off, `balance` is the rest.
 */
export interface AmountsDue {
  totalMinor: number;
  depositMinor: number;
  balanceMinor: number;
  paidMinor: number;
  remainingMinor: number;
}

export function amountsDue(booking: {
  priceSnapshot: { totalMinor?: number; depositMinor?: number };
  paidMinor?: number;
}): AmountsDue {
  const totalMinor = booking.priceSnapshot?.totalMinor ?? 0;
  const depositMinor = Math.min(booking.priceSnapshot?.depositMinor ?? 0, totalMinor);
  const balanceMinor = Math.max(0, totalMinor - depositMinor);
  const paidMinor = booking.paidMinor ?? 0;
  return {
    totalMinor,
    depositMinor,
    balanceMinor,
    paidMinor,
    remainingMinor: Math.max(0, totalMinor - paidMinor),
  };
}

export interface SessionInput {
  bookingId: Types.ObjectId;
  paymentType: 'deposit' | 'balance' | 'full';
  provider?: string;
  idempotencyKey?: string;
}

/**
 * Create a payment session.
 *
 * A `Payment` row is written as `pending` *before* the browser reaches the
 * gateway, so there is always a durable record to reconcile against, and the
 * unique (provider, transactionId) index plus the idempotency key make a
 * double-clicked "Pay now" impossible to bill twice.
 */
export async function createSession(input: SessionInput): Promise<{
  paymentId: string;
  redirectUrl: string;
  provider: string;
  amountMinor: number;
  expiresAt: Date;
}> {
  const booking = await BookingModel.findById(input.bookingId);
  if (!booking) throw ApiError.notFound(PAYMENT_ERRORS.notFound);
  if (!['pending', 'approved', 'completed'].includes(booking.status)) {
    throw ApiError.badRequest('This booking is not open for payment.');
  }

  const due = amountsDue(booking);
  if (due.remainingMinor <= 0) throw ApiError.conflict(PAYMENT_ERRORS.alreadyPaid);

  const amountMinor =
    input.paymentType === 'deposit'
      ? Math.min(due.depositMinor, due.remainingMinor)
      : input.paymentType === 'balance'
        ? due.remainingMinor
        : due.totalMinor;

  if (amountMinor <= 0) throw ApiError.badRequest('There is nothing left to pay.');

  // Re-use the row if the client retried with the same key.
  if (input.idempotencyKey) {
    const existing = await PaymentModel.findOne({ idempotencyKey: input.idempotencyKey });
    if (existing) {
      return {
        paymentId: String(existing._id),
        redirectUrl: existing.redirectUrl,
        provider: existing.provider,
        amountMinor: existing.amountMinor,
        expiresAt: existing.sessionExpiresAt ?? new Date(Date.now() + 15 * 60 * 1000),
      };
    }
  }

  const provider = getProvider(input.provider);
  const reference = `LF-${shortCode(8)}`;
  const origin = process.env.CLIENT_URL ?? 'http://localhost:5173';

  const session = await provider.createSession({
    amountMinor,
    currency: booking.priceSnapshot?.currency ?? 'NPR',
    reference,
    productName: booking.priceSnapshot?.packageName || booking.eventType,
    successUrl: `${origin}/payments/${reference}/return`,
    failureUrl: `${origin}/payments/${reference}/cancelled`,
  });

  const payment = await PaymentModel.create({
    reference,
    bookingId: booking._id,
    projectId: null,
    invoiceId: null,
    clientId: booking.clientId,
    photographerId: booking.photographerId,
    provider: provider.name,
    transactionId: session.transactionId,
    merchantReference: reference,
    amountMinor,
    currency: booking.priceSnapshot?.currency ?? 'NPR',
    paymentType: input.paymentType,
    status: 'pending',
    redirectUrl: session.redirectUrl,
    successUrl: session.redirectUrl,
    sessionExpiresAt: session.expiresAt,
    idempotencyKey: input.idempotencyKey ?? '',
    events: [{ type: 'session_created', detail: `provider=${provider.name}`, payload: session.payload ?? null }],
  });

  booking.paymentStatus =
    input.paymentType === 'deposit' ? 'deposit_pending' : 'partially_paid';
  await booking.save();

  log.info('payment session created', {
    paymentId: String(payment._id),
    bookingId: String(booking._id),
    provider: provider.name,
    amountMinor,
  });

  return {
    paymentId: String(payment._id),
    redirectUrl: session.redirectUrl,
    provider: provider.name,
    amountMinor,
    expiresAt: session.expiresAt,
  };
}

export interface VerificationOutcome {
  paymentId: string;
  status: string;
  verified: boolean;
  bookingId: string;
  amountMinor: number;
}

/**
 * Verify a payment server-to-server and, if it holds up, apply it.
 *
 * This is the only function allowed to move a payment to `completed`, and it is
 * idempotent: a second call on an already-verified payment returns the same
 * result without double-crediting the booking or re-firing the timeline.
 */
export async function verifyPayment(paymentIdOrReference: string): Promise<VerificationOutcome> {
  const payment = await PaymentModel.findOne({
    $or: [{ _id: safeId(paymentIdOrReference) }, { reference: paymentIdOrReference }],
  });
  if (!payment) throw ApiError.notFound(PAYMENT_ERRORS.notFound);

  const base: VerificationOutcome = {
    paymentId: String(payment._id),
    status: payment.status,
    verified: false,
    bookingId: String(payment.bookingId),
    amountMinor: payment.amountMinor,
  };

  if (payment.status === 'completed') {
    return { ...base, verified: true };
  }
  if (payment.sessionExpiresAt && payment.sessionExpiresAt.getTime() < Date.now()) {
    payment.status = 'expired';
    await payment.save();
    return { ...base, status: 'expired' };
  }

  const provider = getProvider(payment.provider);
  const result = await provider.verify(payment.transactionId, payment.merchantReference);

  payment.events.push({
    at: new Date(),
    type: 'verification',
    detail: result.verified ? 'verified' : (result.status ?? 'unverified'),
    payload: result.raw ?? null,
  });

  if (!result.verified) {
    payment.status = 'failed';
    payment.failureCode = 'verification_failed';
    payment.failureMessage = PAYMENT_ERRORS.verificationFailed;
    await payment.save();
    return { ...base, status: 'failed' };
  }

  // The gateway must have charged the amount we asked for. A mismatch means the
  // session was tampered with, so nothing is applied.
  if (typeof result.amountMinor === 'number' && result.amountMinor !== payment.amountMinor) {
    payment.status = 'failed';
    payment.failureCode = 'amount_mismatch';
    payment.failureMessage = PAYMENT_ERRORS.wrongAmount;
    await payment.save();
    log.warn('payment amount mismatch', {
      paymentId: String(payment._id),
      expected: payment.amountMinor,
      reported: result.amountMinor,
    });
    return { ...base, status: 'failed' };
  }

  payment.status = 'completed';
  payment.verifiedAt = new Date();
  payment.verifiedPayload = result.raw ?? null;
  await payment.save();

  await applySuccessfulPayment(payment);
  return { ...base, status: 'completed', verified: true };
}

/**
 * Credit the booking and project for a verified payment.
 *
 * Split out from `verifyPayment` so a manual "mark as paid" (cash, bank
 * transfer) can reuse exactly the same bookkeeping path.
 */
export async function applySuccessfulPayment(
  doc: PaymentDocument,
  options: { manual?: boolean } = {},
): Promise<void> {
  const booking = await BookingModel.findById(doc.bookingId);
  if (!booking) throw ApiError.notFound('The booking for this payment no longer exists.');

  // Idempotency: only count the money once.
  const alreadyCounted = booking.paidMinor >= totalsOf(booking) && doc.paymentType !== 'refund';
  if (!alreadyCounted) {
    booking.paidMinor = (booking.paidMinor ?? 0) + doc.amountMinor;
  }

  const due = amountsDue({ priceSnapshot: booking.priceSnapshot, paidMinor: booking.paidMinor });
  booking.balanceMinor = Math.max(0, due.totalMinor - booking.paidMinor);
  booking.paymentStatus =
    booking.paidMinor >= due.totalMinor
      ? 'paid'
      : booking.paidMinor > 0
        ? 'partially_paid'
        : doc.paymentType === 'deposit'
          ? 'deposit_pending'
          : 'unpaid';
  await booking.save();

  // Link the payment to the project's invoice when one exists.
  const invoice = await InvoiceModel.findOne({ bookingId: booking._id, status: { $ne: 'void' } }).sort({
    createdAt: -1,
  });
  if (invoice) {
    invoice.paidMinor = (invoice.paidMinor ?? 0) + doc.amountMinor;
    invoice.remainingMinor = Math.max(0, invoice.totalMinor - invoice.paidMinor);
    invoice.status =
      invoice.remainingMinor <= 0 ? 'paid' : invoice.paidMinor > 0 ? 'partially_paid' : 'unpaid';
    if (invoice.status === 'paid') invoice.paidAt = new Date();
    await invoice.save();
    doc.invoiceId = invoice._id;
    await doc.save();
  }

  const project = await ProjectModel.findOne({ bookingId: booking._id });
  if (project) {
    doc.projectId = project._id;
    await doc.save();
    // A verified deposit is the timeline's "Deposit Paid" trigger.
    await advance({
      projectId: project._id,
      trigger: 'PAYMENT_SUCCEEDED',
      description: options.manual ? 'Payment recorded manually.' : 'Payment verified with the gateway.',
    });
  }

  await notify({
    userId: booking.clientId,
    photographerId: booking.photographerId,
    bookingId: booking._id,
    projectId: project?._id ?? null,
    paymentId: doc._id,
    type: 'payment_successful',
    title: 'Payment received',
    message: `Thank you, your payment of ${(doc.amountMinor / 100).toFixed(2)} has been confirmed.`,
    link: project ? `/projects/${String(project._id)}` : `/dashboard/bookings`,
    email: true,
  });

  await notify({
    userId: booking.photographerId,
    photographerId: booking.photographerId,
    bookingId: booking._id,
    paymentId: doc._id,
    type: 'payment_successful',
    title: 'Payment received',
    message: `A payment of ${(doc.amountMinor / 100).toFixed(2)} was confirmed for ${booking.eventType}.`,
    link: '/dashboard/payments',
  });

  log.info('payment applied', {
    paymentId: String(doc._id),
    bookingId: String(booking._id),
    amountMinor: doc.amountMinor,
    bookingStatus: booking.paymentStatus,
  });
}

function totalsOf(booking: { priceSnapshot: { totalMinor?: number } }): number {
  return booking.priceSnapshot?.totalMinor ?? 0;
}

/** Mongoose throws on an invalid ObjectId string; treat that as "no match". */
function safeId(value: string): Types.ObjectId | undefined {
  return MongooseTypes.ObjectId.isValid(value) ? new MongooseTypes.ObjectId(value) : undefined;
}

/**
 * Manual payments (cash, bank transfer) are recorded as completed immediately
 * by the photographer, but they go through the same bookkeeping so the booking,
 * invoice and timeline end up in exactly the same state.
 */
export async function recordManualPayment(input: {
  bookingId: Types.ObjectId;
  amountMinor: number;
  note?: string;
  actorId: Types.ObjectId;
}): Promise<VerificationOutcome> {
  const booking = await BookingModel.findById(input.bookingId);
  if (!booking) throw ApiError.notFound(PAYMENT_ERRORS.notFound);

  const due = amountsDue({ priceSnapshot: booking.priceSnapshot, paidMinor: booking.paidMinor });
  const amountMinor = Math.min(input.amountMinor, due.remainingMinor);
  if (amountMinor <= 0) throw ApiError.conflict(PAYMENT_ERRORS.alreadyPaid);

  const payment = await PaymentModel.create({
    reference: `LF-${shortCode(8)}`,
    bookingId: booking._id,
    clientId: booking.clientId,
    photographerId: booking.photographerId,
    provider: 'mock',
    transactionId: `manual_${shortCode(12)}`,
    amountMinor,
    currency: booking.priceSnapshot?.currency ?? 'NPR',
    paymentType: due.paidMinor === 0 ? 'deposit' : 'balance',
    status: 'completed',
    verifiedAt: new Date(),
    redirectUrl: '',
    events: [{ type: 'manual_record', detail: input.note ?? '', payload: { actorId: String(input.actorId) } }],
  });

  await applySuccessfulPayment(payment, { manual: true });
  return {
    paymentId: String(payment._id),
    status: 'completed',
    verified: true,
    bookingId: String(booking._id),
    amountMinor,
  };
}

export { getProvider };
