import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';

const categorySchema = new Schema(
  {
    key: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    label: { type: String, required: true, trim: true },
    description: { type: String, trim: true, maxlength: 400, default: '' },
    sortOrder: { type: Number, default: 100, index: true },
    featured: { type: Boolean, default: false },
    active: { type: Boolean, default: true, index: true },
    /** Optional representative image for the marketing site. */
    image: { type: String, default: null },
  },
  { timestamps: true, toJSON: { virtuals: true } },
);

export type Category = InferSchemaType<typeof categorySchema>;
export const CategoryModel: Model<Category> =
  (mongoose.models.Category as Model<Category>) ?? model<Category>('Category', categorySchema);
