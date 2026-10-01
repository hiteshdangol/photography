import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { PROJECT_STATUSES } from '../config/constants.js';

const projectSchema = new Schema(
  {
    photographerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    clientId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true, index: true },

    title: { type: String, required: true, trim: true, maxlength: 160 },
    slug: { type: String, required: true, lowercase: true, trim: true },
    description: { type: String, trim: true, maxlength: 4000, default: '' },

    eventDate: { type: Date, required: true, index: true },
    location: { type: String, trim: true, maxlength: 240, default: '' },
    eventType: { type: String, trim: true, maxlength: 80, default: '', index: true },
    coverPhotoId: { type: Schema.Types.ObjectId, ref: 'Photo', default: null },

    status: { type: String, enum: PROJECT_STATUSES, default: 'planning', index: true },

    /** Current position in the 11-stage timeline. */
    timelineStage: { type: String, default: 'booking_requested', index: true },
    timelineCompletedAt: { type: Date, default: null },

    gallery: {
      type: new Schema(
        {
          published: { type: Boolean, default: false, index: true },
          publishedAt: { type: Date, default: null },
          highlightsPublishedAt: { type: Date, default: null },
          highlightsCount: { type: Number, default: 0 },
          totalPhotos: { type: Number, default: 0 },
          allowClientDownloads: { type: Boolean, default: true },
          allowOriginalDownloads: { type: Boolean, default: false },
          /** Covers the final delivery step of the timeline. */
          deliveredAt: { type: Date, default: null },
          expiresAt: { type: Date, default: null },
        },
        { _id: false },
      ),
      required: true,
      default: () => ({}),
    },

    counts: {
      type: new Schema(
        {
          photos: { type: Number, default: 0 },
          highlights: { type: Number, default: 0 },
          albums: { type: Number, default: 0 },
          selections: { type: Number, default: 0 },
          favorites: { type: Number, default: 0 },
        },
        { _id: false },
      ),
      required: true,
      default: () => ({}),
    },

    totalMinor: { type: Number, default: 0 },
    currency: { type: String, default: 'NPR' },
  },
  { timestamps: true, toJSON: { virtuals: true } },
);

projectSchema.index({ photographerId: 1, eventDate: -1 });
projectSchema.index({ clientId: 1, eventDate: -1 });
projectSchema.index({ photographerId: 1, status: 1, createdAt: -1 });
projectSchema.index({ clientId: 1, status: 1, createdAt: -1 });
projectSchema.index({ slug: 1 }, { unique: true });
projectSchema.index({ 'gallery.published': 1, eventDate: -1 });

export type Project = InferSchemaType<typeof projectSchema>;
export const ProjectModel: Model<Project> =
  (mongoose.models.Project as Model<Project>) ?? model<Project>('Project', projectSchema);
