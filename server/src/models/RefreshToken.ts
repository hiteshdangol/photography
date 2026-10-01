import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';

/**
 * Refresh token store. Only a SHA-256 hash of the token is persisted, so a
 * database leak cannot be replayed as a session.
 *
 * Rotation + reuse detection: every refresh issues a new token and marks the old
 * one replaced. Presenting an already-replaced token means the token was stolen,
 * so the entire family is revoked.
 */
const refreshTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true, index: true },
    /** All rotated descendants of one login, so reuse detection can nuke the family. */
    familyId: { type: String, required: true, index: true },

    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    replacedByHash: { type: String, default: '' },
    revokedReason: { type: String, default: '' },

    userAgent: { type: String, default: '' },
    ip: { type: String, default: '' },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

refreshTokenSchema.index({ userId: 1, revokedAt: 1 });
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 });

export type RefreshToken = InferSchemaType<typeof refreshTokenSchema>;
export const RefreshTokenModel: Model<RefreshToken> =
  (mongoose.models.RefreshToken as Model<RefreshToken>) ??
  model<RefreshToken>('RefreshToken', refreshTokenSchema);
