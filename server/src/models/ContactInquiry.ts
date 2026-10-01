import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';

const contactInquirySchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    phone: { type: String, trim: true, default: '' },
    subject: { type: String, required: true, trim: true, maxlength: 200 },
    message: { type: String, required: true, trim: true, maxlength: 4000 },

    /** Optional: a visitor enquiring about one specific photographer. */
    photographerId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    categoryKey: { type: String, default: '', index: true },

    status: {
      type: String,
      enum: ['new', 'read', 'replied', 'archived', 'spam'],
      default: 'new',
      index: true,
    },
    readAt: { type: Date, default: null },
    repliedAt: { type: Date, default: null },
    repliedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    replyNote: { type: String, trim: true, maxlength: 4000, default: '' },
    source: { type: String, default: 'website' },
    ip: { type: String, default: '' },
  },
  { timestamps: true, toJSON: { virtuals: true } },
);

contactInquirySchema.index({ status: 1, createdAt: -1 });
contactInquirySchema.index({ photographerId: 1, createdAt: -1 });

export type ContactInquiry = InferSchemaType<typeof contactInquirySchema>;
export const ContactInquiryModel: Model<ContactInquiry> =
  (mongoose.models.ContactInquiry as Model<ContactInquiry>) ??
  model<ContactInquiry>('ContactInquiry', contactInquirySchema);
