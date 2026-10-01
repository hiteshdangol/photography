import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';

const favoriteSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    photoId: { type: Schema.Types.ObjectId, ref: 'Photo', required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    photographerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  },
  { timestamps: true },
);

// A photo can only be favourited once; the unique index makes the API idempotent
// and turns a double-click race into a duplicate-key error we can absorb.
favoriteSchema.index({ clientId: 1, photoId: 1 }, { unique: true });
favoriteSchema.index({ clientId: 1, createdAt: -1 });
favoriteSchema.index({ projectId: 1, photoId: 1 });

export type Favorite = InferSchemaType<typeof favoriteSchema>;
export const FavoriteModel: Model<Favorite> =
  (mongoose.models.Favorite as Model<Favorite>) ?? model<Favorite>('Favorite', favoriteSchema);
