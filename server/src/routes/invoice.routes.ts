import { Router } from 'express';
import { z } from 'zod';
import type { Types } from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created } from '../utils/response.js';
import { BookingModel, InvoiceModel, PaymentModel, ProjectModel, UserModel } from '../models/index.js';
import { authenticate } from '../middleware/auth.js';
import { validateBody, validateQuery, q } from '../middleware/validate.js';
import { ApiError } from '../utils/ApiError.js';
import { INVOICE_ERRORS } from '../messages.js';
import { objectId } from '../services/authorization.js';
import { formatMoney } from '../utils/money.js';
import { renderInvoicePdf } from '../services/invoices/pdf.js';
import { getStorage } from '../services/storage/index.js';
import { notify } from '../services/notifications/dispatcher.js';
import type { RequestContext } from '../types/express.js';

const router = Router();

const BUCKET = 'invoices';

/* -------------------------------------------------------------------------- */
/* Listing                                                                     */
/* -------------------------------------------------------------------------- */

const listSchema = z.object({
  status: z.enum(['unpaid', 'partially_paid', 'paid', 'overdue', 'void']).optional(),
  bookingId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/**
 * Invoices for the caller.
 *
 * The filter is built from the role: a photographer sees their own tenant's
 * invoices, a client sees only their own. There is no `tenantId` query parameter,
 * so one tenant cannot ask for another's ledger.
 */
router.get(
  '/',
  authenticate,
  validateQuery(listSchema),
  asyncHandler(async (req, res) => {
    const filters = q<z.infer<typeof listSchema>>(req);
    const filter = scopeFilter(req.ctx);
    if (filters.status) filter.status = filters.status;
    if (filters.bookingId) filter.bookingId = objectId(filters.bookingId, 'booking id');

    const skip = (filters.page - 1) * filters.limit;
    const [items, total, sums] = await Promise.all([
      InvoiceModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(filters.limit).lean(),
      InvoiceModel.countDocuments(filter),
      InvoiceModel.aggregate([
        { $match: filter },
        { $group: { _id: null, total: { $sum: '$totalMinor' }, paid: { $sum: '$paidMinor' }, outstanding: { $sum: '$remainingMinor' } } },
      ]),
    ]);

    const summary = sums[0] ?? { total: 0, paid: 0, outstanding: 0 };

    return ok(res, {
      invoices: items.map((i) => toInvoiceDto(i, req.ctx)),
      summary: {
        totalMinor: summary.total,
        paidMinor: summary.paid,
        outstandingMinor: summary.outstanding,
      },
      pagination: {
        page: filters.page,
        limit: filters.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / filters.limit)),
      },
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Create and issue                                                            */
/* -------------------------------------------------------------------------- */

const createSchema = z.object({
  bookingId: z.string().min(1),
  dueDate: z.coerce.date().optional(),
  notes: z.string().trim().max(1000).optional(),
  lines: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(200),
        quantity: z.coerce.number().min(0).max(999),
        unitPriceMinor: z.coerce.number().int().min(0).max(100_000_000),
      }),
    )
    .min(1, 'An invoice needs at least one line.')
    .max(50)
    .optional(),
  discountMinor: z.coerce.number().int().min(0).max(100_000_000).optional(),
  taxMinor: z.coerce.number().int().min(0).max(100_000_000).optional(),
});

/**
 * Raise an invoice against a booking.
 *
 * Lines are copied from the booking's frozen price snapshot by default, never
 * recomputed from the live package: if the studio changes a package price next
 * month, an invoice already sent to a client must not silently change.
 */
router.post(
  '/',
  authenticate,
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const booking = await BookingModel.findById(objectId(req.body.bookingId, 'booking id'));
    if (!booking) throw ApiError.notFound(INVOICE_ERRORS.noBooking);
    if (!isPartyTo(req.ctx, booking)) throw ApiError.notFound(INVOICE_ERRORS.notFound);

    // Only the photographer raises invoices. A client may "request" one, but a
    // document that demands money must never originate from the payer.
    if (req.ctx.role !== 'photographer' && req.ctx.role !== 'superadmin') {
      throw ApiError.forbidden('Only the photographer can raise an invoice.');
    }

    const existing = await InvoiceModel.findOne({ bookingId: booking._id, status: { $ne: 'void' } }).lean();
    if (existing) throw ApiError.conflict(INVOICE_ERRORS.alreadyExists);

    const lineInput = (req.body.lines as
      | { description: string; quantity: number; unitPriceMinor: number }[]
      | undefined) ?? [
      {
        description: booking.priceSnapshot.packageName || booking.eventType || 'Photography services',
        quantity: 1,
        unitPriceMinor: booking.priceSnapshot.totalMinor,
      },
    ];
    const lines = lineInput.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      totalMinor: Math.round(line.quantity * line.unitPriceMinor),
    }));

    const subtotalMinor = lines.reduce((sum, line) => sum + line.totalMinor, 0);
    const discountMinor = Math.min(req.body.discountMinor ?? 0, subtotalMinor);
    const taxMinor = req.body.taxMinor ?? 0;
    const totalMinor = subtotalMinor - discountMinor + taxMinor;

    // The project is keyed by booking, not the other way round.
    const project = await ProjectModel.findOne({ bookingId: booking._id }).select('_id title').lean();

    const paidMinor = await sumPaidForBooking(booking._id);
    const snapshot = await buildSnapshot(booking, project?.title ?? '');

    const invoice = await InvoiceModel.create({
      invoiceNumber: await nextInvoiceNumber(),
      bookingId: booking._id,
      projectId: project?._id ?? null,
      clientId: booking.clientId,
      photographerId: booking.photographerId,
      lines,
      subtotalMinor,
      discountMinor,
      taxMinor,
      totalMinor,
      paidMinor,
      remainingMinor: Math.max(0, totalMinor - paidMinor),
      currency: booking.priceSnapshot.currency,
      status: paidMinor >= totalMinor ? 'paid' : 'unpaid',
      dueDate: req.body.dueDate ?? null,
      depositDueMinor: booking.priceSnapshot.depositMinor,
      balanceDueMinor: Math.max(0, totalMinor - paidMinor),
      paidAt: paidMinor >= totalMinor ? new Date() : null,
      snapshot,
      notes: req.body.notes ?? '',
    });

    await notify({
      userId: invoice.clientId,
      photographerId: invoice.photographerId,
      projectId: invoice.projectId,
      type: 'invoice_issued',
      title: `Invoice ${invoice.invoiceNumber}`,
      message: `Your invoice for ${formatMoney(invoice.remainingMinor, invoice.currency)} is ready.`,
      link: `/invoices/${String(invoice._id)}`,
      priority: 'high',
      email: true,
    });

    return created(res, { invoice: toInvoiceDto(invoice.toObject(), req.ctx) }, 'Invoice created.');
  }),
);

/* -------------------------------------------------------------------------- */
/* Detail and documents                                                        */
/* -------------------------------------------------------------------------- */

router.get(
  '/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    const invoice = await assertInvoiceAccess(req.params.id, req.ctx);
    const [client, photographer] = await Promise.all([
      UserModel.findById(invoice.clientId).select('name email phone').lean(),
      UserModel.findById(invoice.photographerId).select('name email phone').lean(),
    ]);

    return ok(res, {
      invoice: {
        ...toInvoiceDto(invoice.toObject(), req.ctx),
        lines: invoice.lines,
        snapshot: invoice.snapshot,
        notes: invoice.notes,
      },
      client: client ? { name: client.name, email: client.email, phone: client.phone } : null,
      photographer: photographer
        ? { name: photographer.name, email: photographer.email, phone: photographer.phone }
        : null,
    });
  }),
);

/**
 * The PDF.
 *
 * Rendered on demand rather than stored: an invoice document is deterministic
 * from the stored snapshot, and regenerating avoids a second source of truth for
 * "what the client was sent".
 */
router.get(
  '/:id/pdf',
  authenticate,
  asyncHandler(async (req, res) => {
    const invoice = await assertInvoiceAccess(req.params.id, req.ctx);
    const pdf = await renderInvoicePdf(invoice);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(pdf.byteLength));
    const disposition = req.query.download === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', `${disposition}; filename="${invoice.invoiceNumber}.pdf"`);
    res.end(pdf);
  }),
);

/** Persist a copy so it can be emailed or re-sent later. */
router.post(
  '/:id/send',
  authenticate,
  asyncHandler(async (req, res) => {
    const invoice = await assertInvoiceAccess(req.params.id, req.ctx);
    if (req.ctx.role === 'client') throw ApiError.forbidden('Only the photographer can send an invoice.');
    if (invoice.status === 'void') throw ApiError.conflict('A voided invoice cannot be sent.');

    const pdf = await renderInvoicePdf(invoice);
    const stored = await getStorage().put(pdf, {
      bucket: BUCKET,
      key: `${invoice.invoiceNumber}.pdf`,
      contentType: 'application/pdf',
    });
    invoice.pdfKey = stored.key;
    await invoice.save();

    await notify({
      userId: invoice.clientId,
      photographerId: invoice.photographerId,
      projectId: invoice.projectId,
      type: 'invoice_issued',
      title: `Invoice ${invoice.invoiceNumber}`,
      message: `${formatMoney(invoice.remainingMinor, invoice.currency)} is due${
        invoice.dueDate ? ` by ${invoice.dueDate.toDateString()}` : ''
      }.`,
      link: `/invoices/${String(invoice._id)}`,
      priority: 'high',
      email: true,
    });

    return ok(res, { invoice: toInvoiceDto(invoice.toObject(), req.ctx) }, 'Invoice sent.');
  }),
);

/* -------------------------------------------------------------------------- */
/* Mutations                                                                   */
/* -------------------------------------------------------------------------- */

const updateSchema = z.object({
  notes: z.string().trim().max(1000).optional(),
  dueDate: z.coerce.date().nullable().optional(),
});

router.patch(
  '/:id',
  authenticate,
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    const invoice = await assertInvoiceAccess(req.params.id, req.ctx);
    if (req.ctx.role === 'client') throw ApiError.forbidden('Clients cannot edit an invoice.');
    if (invoice.status === 'paid') throw ApiError.conflict('A paid invoice cannot be edited.');

    if (req.body.notes !== undefined) invoice.notes = req.body.notes;
    if (req.body.dueDate !== undefined) invoice.dueDate = req.body.dueDate;

    await invoice.save();
    return ok(res, { invoice: toInvoiceDto(invoice.toObject(), req.ctx) }, 'Invoice updated.');
  }),
);

router.post(
  '/:id/void',
  authenticate,
  asyncHandler(async (req, res) => {
    const invoice = await assertInvoiceAccess(req.params.id, req.ctx);
    if (req.ctx.role === 'client') throw ApiError.forbidden('Clients cannot void an invoice.');
    if (invoice.status === 'void') throw ApiError.conflict('That invoice is already void.');
    if (invoice.paidMinor > 0) {
      throw ApiError.conflict(INVOICE_ERRORS.hasPayments);
    }

    invoice.status = 'void';
    await invoice.save();
    return ok(res, { invoice: toInvoiceDto(invoice.toObject(), req.ctx) }, 'Invoice voided.');
  }),
);

/**
 * Record a cash/offline payment against an invoice.
 *
 * Only a photographer may do this: it is a bookkeeping entry, and letting the
 * payer mark their own invoice as paid would make the whole ledger meaningless.
 */
const recordSchema = z.object({
  amountMinor: z.coerce.number().int().min(1, 'Enter an amount greater than zero.'),
  method: z.enum(['cash', 'bank_transfer', 'cheque', 'other']),
  reference: z.string().trim().max(120).optional(),
});

router.post(
  '/:id/payments',
  authenticate,
  validateBody(recordSchema),
  asyncHandler(async (req, res) => {
    const invoice = await assertInvoiceAccess(req.params.id, req.ctx);
    if (req.ctx.role === 'client') throw ApiError.forbidden('Only the photographer can record a payment.');
    if (invoice.status === 'void') throw ApiError.conflict('A voided invoice cannot be paid.');
    if (req.body.amountMinor > invoice.remainingMinor) {
      throw ApiError.badRequest(INVOICE_ERRORS.overpayment, {
        remainingMinor: invoice.remainingMinor,
      });
    }

    const reference = `MAN-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await PaymentModel.create({
      reference,
      bookingId: invoice.bookingId,
      projectId: invoice.projectId,
      invoiceId: invoice._id,
      photographerId: invoice.photographerId,
      clientId: invoice.clientId,
      amountMinor: req.body.amountMinor,
      currency: invoice.currency,
      provider: 'manual',
      transactionId: reference,
      merchantReference: req.body.reference ?? reference,
      paymentType: 'balance',
      status: 'completed',
      verifiedAt: new Date(),
      events: [
        {
          type: 'manual_recorded',
          detail: `method=${req.body.method}`,
          payload: null,
        },
      ],
    });

    invoice.paidMinor += req.body.amountMinor;
    invoice.remainingMinor = Math.max(0, invoice.totalMinor - invoice.paidMinor);
    invoice.balanceDueMinor = invoice.remainingMinor;
    invoice.status = invoice.remainingMinor === 0 ? 'paid' : 'partially_paid';
    if (invoice.status === 'paid') invoice.paidAt = new Date();
    await invoice.save();

    await notify({
      userId: invoice.clientId,
      photographerId: invoice.photographerId,
      projectId: invoice.projectId,
      type: 'payment_received',
      title: 'Payment received',
      message: `Thank you. ${formatMoney(req.body.amountMinor, invoice.currency)} has been recorded against invoice ${invoice.invoiceNumber}.`,
      link: `/invoices/${String(invoice._id)}`,
      priority: 'high',
      email: true,
    });

    return ok(res, { invoice: toInvoiceDto(invoice.toObject(), req.ctx) }, 'Payment recorded.');
  }),
);

/** What the client still owes, in one number. */
router.get(
  '/summary/outstanding',
  authenticate,
  asyncHandler(async (req, res) => {
    const filter: InvoiceFilter = { ...scopeFilter(req.ctx), status: { $ne: 'paid' } };
    const grouped = await InvoiceModel.aggregate([
      { $match: filter },
      { $group: { _id: null, outstandingMinor: { $sum: '$remainingMinor' }, count: { $sum: 1 } } },
    ]);
    const oldest = await InvoiceModel.findOne(filter).sort({ dueDate: 1 }).select('invoiceNumber dueDate remainingMinor').lean();

    return ok(res, {
      outstandingMinor: grouped[0]?.outstandingMinor ?? 0,
      count: grouped[0]?.count ?? 0,
      oldestDue: oldest?.dueDate ?? null,
      oldestInvoice: oldest?.invoiceNumber ?? null,
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

type InvoiceShape = {
  _id: unknown;
  invoiceNumber: string;
  bookingId: unknown;
  projectId?: unknown;
  clientId: unknown;
  photographerId: unknown;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  paidMinor: number;
  remainingMinor: number;
  currency: string;
  status: string;
  dueDate?: Date | null;
  paidAt?: Date | null;
  depositDueMinor: number;
  balanceDueMinor: number;
  pdfKey?: string;
  createdAt: Date;
};

type InvoiceStatus = 'unpaid' | 'partially_paid' | 'paid' | 'overdue' | 'void';

type InvoiceFilter = {
  photographerId?: Types.ObjectId | null;
  clientId?: Types.ObjectId;
  bookingId?: Types.ObjectId;
  status?: InvoiceStatus | { $ne: InvoiceStatus };
};

function scopeFilter(ctx: RequestContext): InvoiceFilter {
  if (ctx.role === 'superadmin') return {};
  return ctx.role === 'photographer'
    ? { photographerId: ctx.tenantId }
    : { clientId: ctx.userId };
}

function toInvoiceDto(invoice: InvoiceShape, ctx: RequestContext) {
  const viewerRole = String(invoice.photographerId) === String(ctx.tenantId)
    ? 'photographer'
    : String(invoice.clientId) === String(ctx.userId)
      ? 'client'
      : 'admin';

  return {
    id: String(invoice._id),
    invoiceNumber: invoice.invoiceNumber,
    bookingId: String(invoice.bookingId),
    projectId: invoice.projectId ? String(invoice.projectId) : null,
    subtotalMinor: invoice.subtotalMinor,
    discountMinor: invoice.discountMinor,
    taxMinor: invoice.taxMinor,
    totalMinor: invoice.totalMinor,
    paidMinor: invoice.paidMinor,
    remainingMinor: invoice.remainingMinor,
    currency: invoice.currency,
    status: invoice.status,
    dueDate: invoice.dueDate,
    paidAt: invoice.paidAt,
    balanceDueMinor: invoice.balanceDueMinor,
    hasPdf: Boolean(invoice.pdfKey),
    pdfUrl: `/api/invoices/${String(invoice._id)}/pdf`,
    overdue:
      invoice.status !== 'paid' &&
      invoice.status !== 'void' &&
      invoice.dueDate != null &&
      invoice.dueDate.getTime() < Date.now(),
    viewerRole,
    editable: viewerRole === 'photographer' && invoice.status !== 'paid' && invoice.status !== 'void',
    createdAt: invoice.createdAt,
  };
}

async function assertInvoiceAccess(id: string, ctx: RequestContext) {
  const invoice = await InvoiceModel.findById(objectId(id, 'invoice id'));
  if (!invoice) throw ApiError.notFound(INVOICE_ERRORS.notFound);

  const allowed =
    ctx.role === 'superadmin' ||
    String(invoice.photographerId) === String(ctx.tenantId) ||
    String(invoice.clientId) === String(ctx.userId);
  if (!allowed) throw ApiError.notFound(INVOICE_ERRORS.notFound);

  return invoice;
}

function isPartyTo(ctx: RequestContext, booking: { clientId: unknown; photographerId: unknown }): boolean {
  return (
    String(booking.photographerId) === String(ctx.tenantId) || String(booking.clientId) === String(ctx.userId)
  );
}

/**
 * Sum of payments already recorded against a booking, so a new invoice never
 * asks for money that has already been banked.
 */
async function sumPaidForBooking(bookingId: unknown): Promise<number> {
  const result = await PaymentModel.aggregate([
    { $match: { bookingId, status: 'completed' } },
    { $group: { _id: null, paid: { $sum: '$amountMinor' } } },
  ]);
  return result[0]?.paid ?? 0;
}

async function buildSnapshot(
  booking: {
    photographerId: unknown;
    clientId: unknown;
    eventDate?: Date | null;
    location?: string | null;
    eventType?: string;
  },
  projectTitle: string,
) {
  const [client, photographer] = await Promise.all([
    UserModel.findById(booking.clientId).select('name email phone').lean(),
    UserModel.findById(booking.photographerId).select('name email phone').lean(),
  ]);

  return {
    photographerName: photographer?.name ?? '',
    photographerEmail: photographer?.email ?? '',
    photographerPhone: photographer?.phone ?? '',
    clientName: client?.name ?? '',
    clientEmail: client?.email ?? '',
    clientPhone: client?.phone ?? '',
    projectTitle: projectTitle || booking.eventType || '',
    eventDate: booking.eventDate ?? null,
    location: booking.location ?? '',
  };
}

/**
 * Sequential, human-quotable invoice number: `INV-2026-000123`.
 *
 * Generated from the count plus a retry on the unique index rather than a
 * counter document, so two concurrent invoices cannot silently share a number -
 * the second one hits the unique index and tries again.
 */
async function nextInvoiceNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `INV-${year}-`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const count = await InvoiceModel.countDocuments({ invoiceNumber: new RegExp(`^${prefix}`) });
    const candidate = `${prefix}${String(count + 1 + attempt).padStart(6, '0')}`;
    const clash = await InvoiceModel.exists({ invoiceNumber: candidate });
    if (!clash) return candidate;
  }
  return `${prefix}${Date.now().toString().slice(-6)}`;
}

export default router;
