import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { PHOTO_CATEGORIES } from '../config/constants.js';

const exifSchema = new Schema(
  {
    camera: { type: String, default: '' },
    lens: { type: String, default: '' },
    iso: { type: Number, default: null },
    aperture: { type: String, default: '' },
    shutter: { type: String, default: '' },
    focalLength: { type: String, default: '' },
    takenAt: { type: Date, default: null },
  },
  { _id: false },
);

/**
 * Photo metadata. Original images are never served directly to gallery users;
 * three derived renditions are generated at upload time and only the
 * appropriate one is streamed, after an authorization check.
 *
 * Paths are *storage keys* (e.g. `originals/2026/09/<id>.jpg`), never absolute
 * filesystem paths, so the storage driver can be swapped for S3 unchanged.
 */
const photoSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    albumId: { type: Schema.Types.ObjectId, ref: 'Album', default: null, index: true },
    /** Denormalised for tenant scoping: every photo query filters on this. */
    photographerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    clientId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** Server-generated safe name. The original client filename is never trusted. */
    filename: { type: String, required: true },
    originalFilename: { type: String, default: '' },
    mimeType: { type: String, required: true },

    originalKey: { type: String, required: true },
    optimizedKey: { type: String, required: true },
    thumbnailKey: { type: String, required: true },

    /** Byte size of each rendition, used for storage-usage reporting. */
    originalSize: { type: Number, default: 0 },
    optimizedSize: { type: Number, default: 0 },
    thumbnailSize: { type: Number, default: 0 },

    width: { type: Number, required: true },
    height: { type: Number, required: true },
    originalWidth: { type: Number, default: 0 },
    originalHeight: { type: Number, default: 0 },
    /** width / height, precomputed for masonry layout without loading the file. */
    aspectRatio: { type: Number, default: 1.5 },

    /** ~24px inline placeholder for the progressive/blur-up loading effect. */
    blurDataUrl: { type: String, default: '' },
    dominantColor: { type: String, default: '#1a1a1a' },

    isHighlight: { type: Boolean, default: false, index: true },
    /** Manual ordering within the highlights reel. */
    highlightOrder: { type: Number, default: 0 },
    sortOrder: { type: Number, default: 0 },

    category: { type: String, enum: PHOTO_CATEGORIES, default: 'other', index: true },
    caption: { type: String, trim: true, maxlength: 500, default: '' },

    /** Per-photo override of the project download policy. */
    allowDownload: { type: Boolean, default: true },
    /** Photographs a client selected; these are always downloadable. */
    allowOriginalDownload: { type: Boolean, default: false },

    counts: {
      type: new Schema(
        {
          favorites: { type: Number, default: 0 },
          selections: { type: Number, default: 0 },
          comments: { type: Number, default: 0 },
        },
        { _id: false },
      ),
      required: true,
      default: () => ({ favorites: 0, selections: 0, comments: 0 }),
    },
    favoriteCount: { type: Number, default: 0 },
    selectionCount: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },

    uploadedAt: { type: Date, default: Date.now, index: true },
    capturedAt: { type: Date, default: null },
    exif: { type: exifSchema, default: () => ({}) },
  },
  { timestamps: true, toJSON: { virtuals: true } },
);

// The gallery hot path: photos for a project, ordered, highlight-aware.
photoSchema.index({ projectId: 1, sortOrder: 1, _id: 1 });
photoSchema.index({ projectId: 1, isHighlight: 1, highlightOrder: 1 });
photoSchema.index({ albumId: 1, sortOrder: 1 });
photoSchema.index({ photographerId: 1, uploadedAt: -1 });
photoSchema.index({ projectId: 1, category: 1, sortOrder: 1 });
photoSchema.index({ projectId: 1, uploadedAt: -1, _id: -1 }); // cursor pagination
photoSchema.index({ originalKey: 1 });

export type Photo = InferSchemaType<typeof photoSchema>;
export const PhotoModel: Model<Photo> =
  (mongoose.models.Photo as Model<Photo>) ?? model<Photo>('Photo', photoSchema);
