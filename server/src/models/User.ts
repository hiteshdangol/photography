import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { USER_ROLES, USER_STATUSES } from '../config/constants.js';

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    /** Always a bcrypt hash. Never logged, never selected by default. */
    password: { type: String, required: true, select: false },
    role: { type: String, enum: USER_ROLES, required: true, index: true },
    phone: { type: String, trim: true },
    avatar: { type: String, default: null },
    status: { type: String, enum: USER_STATUSES, default: 'active', index: true },
    emailVerified: { type: Boolean, default: false },
    lastLoginAt: { type: Date, default: null },

    // Admin moderation
    suspendedAt: { type: Date, default: null },
    suspendedReason: { type: String, default: null },

    // Password reset (hashed; never store the raw token)
    passwordResetTokenHash: { type: String, default: null, select: false },
    passwordResetExpiresAt: { type: Date, default: null, select: false },
    passwordChangedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform(_doc, ret: Record<string, unknown>) {
        delete ret.password;
        delete ret.passwordResetTokenHash;
        delete ret.passwordResetExpiresAt;
        delete ret.__v;
        ret.id = ret._id;
        delete ret._id;
        return ret;
      },
    },
  },
);

// Partial-text search for the login form and admin user lookup.
userSchema.index({ name: 'text', email: 'text' });
// "Active photographers for the directory" and "active clients for a tenant".
userSchema.index({ role: 1, status: 1 });
userSchema.index({ role: 1, createdAt: -1 });

export type User = InferSchemaType<typeof userSchema>;
export const UserModel: Model<User> =
  (mongoose.models.User as Model<User>) ?? model<User>('User', userSchema);
