import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';

/** A photographer's bookable service, e.g. "Wedding Coverage" or "Pre-wedding Shoot". */
const serviceSchema = new Schema(
  {
    photographerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, lowercase: true, trim: true },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    categoryKey: { type: String, trim: true, default: '', index: true },
    durationHours: { type: Number, min: 0, max: 24, default: null },
    basePrice: { type: Number, min: 0, default: 0 },
    deliverables: { type: [String], default: [] },
    active: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true, toJSON: { virtuals: true } },
);

serviceSchema.index({ photographerId: 1, active: 1, sortOrder: 1 });
serviceSchema.index({ photographerId: 1, slug: 1 }, { unique: true });

export type Service = InferSchemaType<typeof serviceSchema>;
export const ServiceModel: Model<Service> =
  (mongoose.models.Service as Model<Service>) ?? model<Service>('Service', serviceSchema);
