import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { ALBUM_STATUSES } from '../config/constants.js';

const albumSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    photographerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    clientId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 1000, default: '' },

    /**
     * How many photos the client may select. `null` means unlimited.
     * Enforced server-side on every selection mutation.
     */
    selectionLimit: { type: Number, min: 0, default: null },
    status: { type: String, enum: ALBUM_STATUSES, default: 'draft', index: true },
    published: { type: Boolean, default: false, index: true },
    publishedAt: { type: Date, default: null },

    coverPhotoId: { type: Schema.Types.ObjectId, ref: 'Photo', default: null },
    sortOrder: { type: Number, default: 0 },

    counts: {
      type: new Schema(
        {
          photos: { type: Number, default: 0 },
          selected: { type: Number, default: 0, index: true },
        },
        { _id: false },
      ),
      required: true,
      default: () => ({ photos: 0, selected: 0 }),
    },

    selectionOpenAt: { type: Date, default: null },
    selectionDueAt: { type: Date, default: null },
    selectionCompletedAt: { type: Date, default: null },
    /** Photographer notified once the client hits the required count. */
    completionNotifiedAt: { type: Date, default: null },
  },
  { timestamps: true, toJSON: { virtuals: true } },
);

albumSchema.index({ projectId: 1, sortOrder: 1 });
albumSchema.index({ photographerId: 1, status: 1, createdAt: -1 });
albumSchema.index({ projectId: 1, name: 1 });

export type Album = InferSchemaType<typeof albumSchema>;
export const AlbumModel: Model<Album> =
  (mongoose.models.Album as Model<Album>) ?? model<Album>('Album', albumSchema);
