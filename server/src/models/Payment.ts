import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { PAYMENT_PROVIDERS, PAYMENT_TYPES, TRANSACTION_STATUSES } from '../config/constants.js';

const refundSchema = new Schema(
  {
    /**
     * Defaults to 0 rather than being `required` so the `not_requested` default
     * below is itself a valid document. Requiring it would make every
     * `PaymentModel.create` that omits `refund` fail validation, which is every
     * ordinary payment.
     */
    amountMinor: { type: Number, required: true, min: 0, default: 0 },
    status: {
      type: String,
      enum: ['not_requested', 'requested', 'processing', 'completed', 'failed', 'cancelled'],
      default: 'not_requested',
      index: true,
    },
    reason: { type: String, trim: true, maxlength: 600, default: '' },
    requestedAt: { type: Date, default: null },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    processedAt: { type: Date, default: null },
    processedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    providerRefundId: { type: String, default: '' },
    failureReason: { type: String, default: '' },
  },
  { _id: false },
);

const eventSchema = new Schema(
  {
    at: { type: Date, default: Date.now },
    type: { type: String, required: true },
    detail: { type: String, default: '' },
    /** Gateway callback payload, stored for disputes. */
    payload: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

/**
 * One payment attempt / transaction.
 *
 * A Payment row is created as `pending` *before* the client ever reaches the
 * gateway, and is only ever moved to `completed` by a server-to-server
 * verification call. The browser callback is treated as an untrusted hint that
 * triggers verification, never as proof of payment.
 */
const paymentSchema = new Schema(
  {
    reference: { type: String, required: true, unique: true, index: true },

    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null, index: true },
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', default: null, index: true },

    clientId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    photographerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    provider: { type: String, enum: PAYMENT_PROVIDERS, required: true, index: true },
    /** The provider's transaction identifier (esewa transaction_uuid / khalti pidx). */
    transactionId: { type: String, required: true, index: true },
    /** Gateway-level reference we echo back to keep our own id in their records. */
    merchantReference: { type: String, default: '' },

    amountMinor: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'NPR' },
    paymentType: { type: String, enum: PAYMENT_TYPES, required: true, index: true },

    status: { type: String, enum: TRANSACTION_STATUSES, default: 'created', index: true },
    verifiedAt: { type: Date, default: null },
    verifiedPayload: { type: Schema.Types.Mixed, default: null },
    failureCode: { type: String, default: '' },
    failureMessage: { type: String, default: '' },

    /** Where the gateway should send the user back to. */
    redirectUrl: { type: String, default: '' },
    successUrl: { type: String, default: '' },
    failureUrl: { type: String, default: '' },
    sessionExpiresAt: { type: Date, default: null },

    refund: { type: refundSchema, default: () => ({ status: 'not_requested' }) },
    events: { type: [eventSchema], default: [] },

    /**
     * Set when a verified payment would double-charge an already-paid item.
     * Left absent (not empty-string) so the sparse unique index below only
     * covers rows that actually carry a key.
     */
    idempotencyKey: { type: String },
  },
  { timestamps: true, toJSON: { virtuals: true } },
);

// The duplicate-payment guard: one provider transaction can only be recorded once.
paymentSchema.index({ provider: 1, transactionId: 1 }, { unique: true });
paymentSchema.index({ photographerId: 1, createdAt: -1 });
paymentSchema.index({ clientId: 1, createdAt: -1 });
paymentSchema.index({ photographerId: 1, status: 1, createdAt: -1 });
paymentSchema.index({ bookingId: 1, status: 1 });
paymentSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

export type Payment = InferSchemaType<typeof paymentSchema>;
export const PaymentModel: Model<Payment> =
  (mongoose.models.Payment as Model<Payment>) ?? model<Payment>('Payment', paymentSchema);
