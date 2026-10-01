import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';

const accessLogSchema = new Schema(
  {
    at: { type: Date, default: Date.now, index: true },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
  },
  { _id: false },
);

/**
 * A shareable private gallery link.
 *
 * Critical property: the token alone is NOT access. A visitor still has to be
 * signed in *and* be the project's client (or the owning photographer). The
 * token only proves which gallery was being shared, and lets us revoke or
 * expire access independently of the project itself.
 */
const galleryShareSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    photographerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    clientId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    /** Store only a hash of the token; the raw value is returned once at creation. */
    tokenHash: { type: String, required: true, unique: true, index: true },
    tokenHint: { type: String, default: '' },

    label: { type: String, trim: true, maxlength: 120, default: '' },
    active: { type: Boolean, default: true, index: true },
    expiresAt: { type: Date, default: null, index: true },
    revokedAt: { type: Date, default: null },

    maxAccesses: { type: Number, min: 0, default: 0 }, // 0 = unlimited
    accessCount: { type: Number, default: 0 },
    lastAccessedAt: { type: Date, default: null },
    firstAccessedAt: { type: Date, default: null },
    accessLog: { type: [accessLogSchema], default: [] },
  },
  { timestamps: true, toJSON: { virtuals: true } },
);

galleryShareSchema.index({ projectId: 1, active: 1, createdAt: -1 });
galleryShareSchema.index({ photographerId: 1, active: 1 });
galleryShareSchema.index({ expiresAt: 1, active: 1 });

export type GalleryShare = InferSchemaType<typeof galleryShareSchema>;
export const GalleryShareModel: Model<GalleryShare> =
  (mongoose.models.GalleryShare as Model<GalleryShare>) ??
  model<GalleryShare>('GalleryShare', galleryShareSchema);
