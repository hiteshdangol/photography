import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';

const verificationTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    purpose: { type: String, enum: ['email_verification', 'password_reset'], required: true },
    tokenHash: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

verificationTokenSchema.index({ userId: 1, purpose: 1 });
verificationTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 });

export type VerificationToken = InferSchemaType<typeof verificationTokenSchema>;
export const VerificationTokenModel: Model<VerificationToken> =
  (mongoose.models.VerificationToken as Model<VerificationToken>) ??
  model<VerificationToken>('VerificationToken', verificationTokenSchema);
