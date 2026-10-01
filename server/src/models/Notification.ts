import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { NOTIFICATION_TYPES } from '../config/constants.js';

const notificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** For tenant-scoped notifications, who the notification is about. */
    photographerId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    type: { type: String, enum: NOTIFICATION_TYPES, required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    message: { type: String, trim: true, maxlength: 1000, default: '' },
    /** Client-side route, e.g. /projects/<id>/highlights */
    link: { type: String, default: '' },

    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', default: null },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null },
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment', default: null },
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', default: null },

    read: { type: Boolean, default: false, index: true },
    readAt: { type: Date, default: null },

    /** Email delivery state - the in-app row is created even if email fails. */
    email: {
      type: new Schema(
        {
          sent: { type: Boolean, default: false },
          sentAt: { type: Date, default: null },
          failedAt: { type: Date, default: null },
          error: { type: String, default: '' },
        },
        { _id: false },
      ),
      required: true,
      default: () => ({}),
    },

    priority: { type: String, enum: ['low', 'normal', 'high'], default: 'normal' },
  },
  { timestamps: true, toJSON: { virtuals: true } },
);

notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ type: 1, createdAt: -1 });

export type Notification = InferSchemaType<typeof notificationSchema>;
export const NotificationModel: Model<Notification> =
  (mongoose.models.Notification as Model<Notification>) ?? model<Notification>('Notification', notificationSchema);
