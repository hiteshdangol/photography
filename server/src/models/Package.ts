import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';

/**
 * Photographer-defined packages. Nothing about pricing is hardcoded: the
 * photographer creates, edits, activates and deactivates their own packages.
 *
 * Money is stored twice on purpose:
 *  - `price` / `depositValue` as major units (NPR 50,000) for the UI, and
 *  - `priceMinor` / `depositMinor` as integer minor units for all arithmetic.
 * The minor values are recomputed server-side on every write; never trust the
 * client to send them.
 */
const packageSchema = new Schema(
  {
    photographerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    slug: { type: String, required: true, lowercase: true, trim: true },
    description: { type: String, trim: true, maxlength: 2000, default: '' },

    price: { type: Number, required: true, min: 0 },
    priceMinor: { type: Number, required: true, min: 0 },

    currency: { type: String, default: 'NPR' },

    depositType: { type: String, enum: ['percent', 'fixed', 'full', 'none'], default: 'percent' },
    depositValue: { type: Number, default: 30, min: 0 },
    depositMinor: { type: Number, default: 0, min: 0 },

    /** Total shoot hours the package covers (used for duration-aware availability). */
    durationHours: { type: Number, min: 0, max: 24, default: 4 },
    photographers: { type: Number, min: 0, max: 20, default: 1 },
    videographers: { type: Number, min: 0, max: 20, default: 0 },
    editedPhotoCount: { type: Number, min: 0, default: 0 },
    turnaroundDays: { type: Number, min: 0, max: 365, default: 21 },
    includedServices: { type: [String], default: [] },
    deliverables: { type: [String], default: [] },
    categoryKeys: { type: [String], default: [], index: true },

    active: { type: Boolean, default: true, index: true },
    featured: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 0 },
    /** Highlight album included, surfaced on the package card. */
    includesHighlightAlbum: { type: Boolean, default: false },
    includesPrintedAlbum: { type: Boolean, default: false },
  },
  { timestamps: true, toJSON: { virtuals: true } },
);

packageSchema.index({ photographerId: 1, active: 1, sortOrder: 1, price: 1 });
packageSchema.index({ photographerId: 1, slug: 1 }, { unique: true });
packageSchema.index({ active: 1, price: 1, 'rating.average': -1 });
// Directory search by price band.
packageSchema.index({ price: 1, active: 1 });

export type Package = InferSchemaType<typeof packageSchema>;
export const PackageModel: Model<Package> =
  (mongoose.models.Package as Model<Package>) ?? model<Package>('Package', packageSchema);
