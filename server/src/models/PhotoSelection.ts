import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';

const photoSelectionSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    photoId: { type: Schema.Types.ObjectId, ref: 'Photo', required: true, index: true },
    albumId: { type: Schema.Types.ObjectId, ref: 'Album', required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    photographerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Client's own ranking, 1..N, for album ordering. */
    rank: { type: Number, default: 0, min: 0 },
    note: { type: String, trim: true, maxlength: 300, default: '' },
  },
  { timestamps: true },
);

photoSelectionSchema.index({ clientId: 1, albumId: 1, rank: 1 });
// Enforces "one album, one selection per photo" - the basis of the limit check.
photoSelectionSchema.index({ clientId: 1, albumId: 1, photoId: 1 }, { unique: true });
photoSelectionSchema.index({ projectId: 1, albumId: 1 });

export type PhotoSelection = InferSchemaType<typeof photoSelectionSchema>;
export const PhotoSelectionModel: Model<PhotoSelection> =
  (mongoose.models.PhotoSelection as Model<PhotoSelection>) ??
  model<PhotoSelection>('PhotoSelection', photoSelectionSchema);
