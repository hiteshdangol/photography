import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';

/**
 * Threaded photo comments. One extra level of nesting is enough for the
 * "client asks, photographer answers" flow and keeps the UI simple.
 */
const photoCommentSchema = new Schema(
  {
    photoId: { type: Schema.Types.ObjectId, ref: 'Photo', required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    photographerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Denormalised so the viewer can show a role badge without a lookup. */
    userRole: { type: String, enum: ['photographer', 'client', 'superadmin'], required: true },

    parentId: { type: Schema.Types.ObjectId, ref: 'PhotoComment', default: null, index: true },

    comment: { type: String, required: true, trim: true, maxlength: 2000 },
    read: { type: Boolean, default: false, index: true },
    readAt: { type: Date, default: null },
    editedAt: { type: Date, default: null },
  },
  { timestamps: true, toJSON: { virtuals: true } },
);

photoCommentSchema.index({ photoId: 1, createdAt: 1 });
photoCommentSchema.index({ projectId: 1, createdAt: -1 });
photoCommentSchema.index({ userId: 1, read: 1 });

export type PhotoComment = InferSchemaType<typeof photoCommentSchema>;
export const PhotoCommentModel: Model<PhotoComment> =
  (mongoose.models.PhotoComment as Model<PhotoComment>) ??
  model<PhotoComment>('PhotoComment', photoCommentSchema);
