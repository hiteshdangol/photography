import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { BOOKING_STATUSES, PAYMENT_STATUSES } from '../config/constants.js';

const bookingSchema = new Schema(
  {
    /** Human reference shown to both parties, e.g. LF-BK-8FK2QW. */
    reference: { type: String, required: true, unique: true, index: true },

    photographerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    clientId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    packageId: { type: Schema.Types.ObjectId, ref: 'Package', default: null },

    eventType: { type: String, required: true, trim: true, maxlength: 80, index: true },
    eventDate: { type: Date, required: true, index: true },
    /** Local wall-clock times "HH:mm"; the photographer's timezone is assumed. */
    startTime: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    endTime: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    durationHours: { type: Number, min: 0, default: 0 },

    location: { type: String, required: true, trim: true, maxlength: 240 },
    guestCount: { type: Number, min: 0, max: 100000, default: null },

    // Price snapshot taken at request time so later package edits never rewrite history.
    priceSnapshot: {
      type: new Schema(
        {
          packageName: { type: String, default: '' },
          total: { type: Number, default: 0 },
          totalMinor: { type: Number, default: 0 },
          currency: { type: String, default: 'NPR' },
          depositType: { type: String, enum: ['percent', 'fixed', 'full', 'none'], default: 'percent' },
          depositValue: { type: Number, default: 0 },
          depositMinor: { type: Number, default: 0 },
        },
        { _id: false },
      ),
      required: true,
      default: () => ({}),
    },
    additionalServices: {
      type: new Schema(
        {
          name: { type: String, trim: true, default: '' },
          price: { type: Number, min: 0, default: 0 },
          priceMinor: { type: Number, min: 0, default: 0 },
        },
        { _id: false },
      ),
      required: true,
      default: () => ({}),
    },
    budget: { type: Number, min: 0, default: null },
    notes: { type: String, trim: true, maxlength: 4000, default: '' },

    status: { type: String, enum: BOOKING_STATUSES, default: 'pending', index: true },
    paymentStatus: { type: String, enum: PAYMENT_STATUSES, default: 'unpaid', index: true },
    paidMinor: { type: Number, default: 0, min: 0 },
    balanceMinor: { type: Number, default: 0, min: 0 },

    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    rejectionReason: { type: String, trim: true, maxlength: 600, default: '' },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    cancellationReason: { type: String, trim: true, maxlength: 600, default: '' },

    /** Set once an overlapping booking is detected, for analytics. */
    conflictCheckedAt: { type: Date, default: null },
  },
  { timestamps: true, toJSON: { virtuals: true } },
);

// The single most important index for tenant safety plus calendar queries.
bookingSchema.index({ photographerId: 1, eventDate: 1, status: 1 });
bookingSchema.index({ clientId: 1, eventDate: -1 });
bookingSchema.index({ photographerId: 1, status: 1, createdAt: -1 });
bookingSchema.index({ clientId: 1, status: 1, createdAt: -1 });
bookingSchema.index({ eventType: 1, eventDate: -1 });

export type Booking = InferSchemaType<typeof bookingSchema>;
export const BookingModel: Model<Booking> =
  (mongoose.models.Booking as Model<Booking>) ?? model<Booking>('Booking', bookingSchema);
