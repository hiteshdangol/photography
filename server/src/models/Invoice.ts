import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { INVOICE_STATUSES } from '../config/constants.js';

const invoiceLineSchema = new Schema(
  {
    description: { type: String, required: true, trim: true },
    quantity: { type: Number, default: 1, min: 0 },
    unitPriceMinor: { type: Number, required: true, min: 0 },
    totalMinor: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const invoiceSchema = new Schema(
  {
    invoiceNumber: { type: String, required: true, unique: true, index: true },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null, index: true },

    clientId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    photographerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    lines: { type: [invoiceLineSchema], default: [] },
    subtotalMinor: { type: Number, default: 0, min: 0 },
    discountMinor: { type: Number, default: 0, min: 0 },
    taxMinor: { type: Number, default: 0, min: 0 },
    totalMinor: { type: Number, default: 0, min: 0 },
    paidMinor: { type: Number, default: 0, min: 0 },
    remainingMinor: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'NPR' },

    status: { type: String, enum: INVOICE_STATUSES, default: 'unpaid', index: true },
    dueDate: { type: Date, default: null, index: true },
    paidAt: { type: Date, default: null },
    overdueNotifiedAt: { type: Date, default: null },
    depositDueMinor: { type: Number, default: 0, min: 0 },
    balanceDueMinor: { type: Number, default: 0, min: 0 },

    /** Frozen snapshot of names/addresses, so the PDF never changes retroactively. */
    snapshot: {
      type: new Schema(
        {
          photographerName: { type: String, default: '' },
          photographerBusiness: { type: String, default: '' },
          photographerEmail: { type: String, default: '' },
          photographerPhone: { type: String, default: '' },
          photographerAddress: { type: String, default: '' },
          clientName: { type: String, default: '' },
          clientEmail: { type: String, default: '' },
          clientPhone: { type: String, default: '' },
          projectTitle: { type: String, default: '' },
          eventDate: { type: Date, default: null },
          location: { type: String, default: '' },
        },
        { _id: false },
      ),
      required: true,
      default: () => ({}),
    },

    pdfKey: { type: String, default: '' },
    notes: { type: String, trim: true, maxlength: 1000, default: '' },
  },
  { timestamps: true, toJSON: { virtuals: true } },
);

invoiceSchema.index({ photographerId: 1, createdAt: -1 });
invoiceSchema.index({ clientId: 1, createdAt: -1 });
invoiceSchema.index({ photographerId: 1, status: 1, dueDate: 1 });
invoiceSchema.index({ status: 1, dueDate: 1 });

export type Invoice = InferSchemaType<typeof invoiceSchema>;
export const InvoiceModel: Model<Invoice> =
  (mongoose.models.Invoice as Model<Invoice>) ?? model<Invoice>('Invoice', invoiceSchema);
