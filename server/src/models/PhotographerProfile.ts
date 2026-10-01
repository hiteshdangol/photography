import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { ratingBreakdownSchema, addressSchema } from './shared.js';

const photographerProfileSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    businessName: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    tagline: { type: String, trim: true, maxlength: 160, default: '' },
    bio: { type: String, trim: true, maxlength: 4000, default: '' },
    location: { type: String, trim: true, maxlength: 120, default: '' },
    address: { type: addressSchema, default: () => ({ country: 'Nepal' }) },
    specialties: { type: [String], default: [], index: true },
    profileImage: { type: String, default: null },
    coverImage: { type: String, default: null },
    portfolioCover: { type: String, default: null },

    yearsExperience: { type: Number, min: 0, max: 70, default: null },
    website: { type: String, trim: true, default: '' },
    instagram: { type: String, trim: true, default: '' },
    facebook: { type: String, trim: true, default: '' },
    whatsapp: { type: String, trim: true, default: '' },

    rating: { type: ratingBreakdownSchema, default: () => ({ average: 0, count: 0 }) },
    startingPrice: { type: Number, min: 0, default: 0 },

    verification: {
      type: new Schema(
        {
          verified: { type: Boolean, default: false },
          verifiedAt: { type: Date, default: null },
          document: { type: String, default: null },
        },
        { _id: false },
      ),
      required: true,
      default: () => ({}),
    },

    /** Public visibility of the profile in the directory. */
    published: { type: Boolean, default: true, index: true },
    featured: { type: Boolean, default: false },

    settings: {
      type: new Schema(
        {
          currency: { type: String, default: 'NPR' },
          /** Default deposit policy applied when a package does not override it. */
          depositType: { type: String, enum: ['percent', 'fixed', 'full', 'none'], default: 'percent' },
          depositValue: { type: Number, default: 30, min: 0, max: 100 },
          /** Require a deposit before the booking is confirmed as active. */
          requireDeposit: { type: Boolean, default: true },
          /** Allow clients to download optimized files from the gallery. */
          allowClientDownloads: { type: Boolean, default: true },
          /** Allow clients to download full-resolution originals. */
          allowOriginalDownloads: { type: Boolean, default: false },
          /** Automatically advance timeline stages from system events. */
          autoTimeline: { type: Boolean, default: true },
          /** Days before a session that reminders fire. */
          reminderDaysBefore: { type: Number, default: 3, min: 0, max: 60 },
          galleryLinkDefaultExpiryDays: { type: Number, default: 30, min: 1, max: 365 },
        },
        { _id: false },
      ),
      required: true,
      default: () => ({}),
    },

    stats: {
      type: new Schema(
        {
          totalProjects: { type: Number, default: 0 },
          totalPhotos: { type: Number, default: 0 },
          totalBookings: { type: Number, default: 0 },
        },
        { _id: false },
      ),
      required: true,
      default: () => ({}),
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true, transform: stripMeta },
  },
);

// Directory search: published + text + specialty + location + price.
photographerProfileSchema.index({ published: 1, featured: -1, createdAt: -1 });
photographerProfileSchema.index({ 'address.city': 1, specialties: 1 });
photographerProfileSchema.index({ startingPrice: 1 });
photographerProfileSchema.index({ 'rating.average': -1 });
photographerProfileSchema.index({ businessName: 'text', bio: 'text', location: 'text', tagline: 'text' });

function stripMeta(_doc: unknown, ret: Record<string, unknown>) {
  delete ret.__v;
  ret.id = ret._id;
  delete ret._id;
  return ret;
}

export type PhotographerProfile = InferSchemaType<typeof photographerProfileSchema>;
export const PhotographerProfileModel: Model<PhotographerProfile> =
  (mongoose.models.PhotographerProfile as Model<PhotographerProfile>) ??
  model<PhotographerProfile>('PhotographerProfile', photographerProfileSchema);
