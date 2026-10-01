import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';

/** Single document collection: platform-wide configuration edited by the admin. */
const platformSettingsSchema = new Schema(
  {
    key: { type: String, default: 'default', unique: true, index: true },

    siteName: { type: String, default: 'LensFlow' },
    tagline: { type: String, default: 'Capture. Connect. Create Memories.' },
    supportEmail: { type: String, default: '' },
    supportPhone: { type: String, default: '' },
    defaultCurrency: { type: String, default: 'NPR' },
    currencySymbol: { type: String, default: 'NPR' },

    maintenance: {
      enabled: { type: Boolean, default: false },
      message: { type: String, default: '' },
      allowPhotographers: { type: Boolean, default: true },
      allowRegistrations: { type: Boolean, default: true },
    },

    registration: {
      requireEmailVerification: { type: Boolean, default: false },
      defaultClientRole: { type: String, default: 'client' },
    },

    payments: {
      enabled: { type: Boolean, default: true },
      activeProvider: { type: String, default: 'mock' },
      /** The admin can force a provider on/off regardless of env config. */
      allowedProviders: { type: [String], default: ['mock', 'esewa', 'khalti'] },
      depositEnforced: { type: Boolean, default: true },
    },

    features: {
      chat: { type: Boolean, default: true },
      highlights: { type: Boolean, default: true },
      albumSelection: { type: Boolean, default: true },
      testimonials: { type: Boolean, default: true },
      sharing: { type: Boolean, default: true },
    },

    storage: {
      maxUploadMb: { type: Number, default: 25 },
      warnStoragePercent: { type: Number, default: 80 },
    },

    social: {
      instagram: { type: String, default: '' },
      facebook: { type: String, default: '' },
      twitter: { type: String, default: '' },
      youtube: { type: String, default: '' },
    },
  },
  { timestamps: true, toJSON: { virtuals: true } },
);

export type PlatformSettings = InferSchemaType<typeof platformSettingsSchema>;
export const PlatformSettingsModel: Model<PlatformSettings> =
  (mongoose.models.PlatformSettings as Model<PlatformSettings>) ??
  model<PlatformSettings>('PlatformSettings', platformSettingsSchema);
