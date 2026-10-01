import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';

const testimonialSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    photographerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', default: null },

    rating: { type: Number, required: true, min: 1, max: 5, index: true },
    title: { type: String, trim: true, maxlength: 160, default: '' },
    content: { type: String, required: true, trim: true, maxlength: 3000 },
    /** Photographer name and avatar frozen at the time of writing. */
    authorName: { type: String, default: '' },
    authorAvatar: { type: String, default: '' },
    eventType: { type: String, default: '' },

    approved: { type: Boolean, default: false, index: true },
    approvedAt: { type: Date, default: null },
    rejectedReason: { type: String, trim: true, maxlength: 400, default: '' },
    featured: { type: Boolean, default: false, index: true },

    /** Set when the photographer explicitly asked for a testimonial. */
    requestedAt: { type: Date, default: null },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true, toJSON: { virtuals: true } },
);

testimonialSchema.index({ photographerId: 1, approved: 1, createdAt: -1 });
testimonialSchema.index({ approved: 1, featured: -1, createdAt: -1 });
// A client writes at most one testimonial per project.
testimonialSchema.index(
  { clientId: 1, photographerId: 1, projectId: 1 },
  { unique: true, partialFilterExpression: { projectId: { $type: 'objectId' } } },
);

export type Testimonial = InferSchemaType<typeof testimonialSchema>;
export const TestimonialModel: Model<Testimonial> =
  (mongoose.models.Testimonial as Model<Testimonial>) ??
  model<Testimonial>('Testimonial', testimonialSchema);
