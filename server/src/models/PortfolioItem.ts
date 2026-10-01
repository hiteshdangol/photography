import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';

const portfolioItemSchema = new Schema(
  {
    photographerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, trim: true, maxlength: 160, default: '' },
    description: { type: String, trim: true, maxlength: 1000, default: '' },
    categoryKey: { type: String, trim: true, default: '', index: true },

    imageKey: { type: String, required: true },
    thumbnailKey: { type: String, required: true },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    aspectRatio: { type: Number, default: 1.5 },
    blurDataUrl: { type: String, default: '' },
    size: { type: Number, default: 0 },
    mimeType: { type: String, default: 'image/jpeg' },

    /** Lead image on the public profile. */
    featured: { type: Boolean, default: false, index: true },
    sortOrder: { type: Number, default: 0 },
    published: { type: Boolean, default: true, index: true },
    /** Optional link to a published project this shot came from. */
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null },
  },
  { timestamps: true, toJSON: { virtuals: true } },
);

portfolioItemSchema.index({ photographerId: 1, published: 1, sortOrder: 1 });
portfolioItemSchema.index({ photographerId: 1, categoryKey: 1, sortOrder: 1 });

export type PortfolioItem = InferSchemaType<typeof portfolioItemSchema>;
export const PortfolioItemModel: Model<PortfolioItem> =
  (mongoose.models.PortfolioItem as Model<PortfolioItem>) ??
  model<PortfolioItem>('PortfolioItem', portfolioItemSchema);
