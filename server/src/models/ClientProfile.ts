import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';

const clientProfileSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    /**
     * Tenant relationship. A client may work with several photographers, so this
     * is a link collection rather than a single field. Every client-scoped
     * business record (booking, project, album...) carries the photographerId
     * that owns it, and access is always checked against that pair.
     */
    photographerIds: { type: [Schema.Types.ObjectId], ref: 'User', default: [], index: true },

    dateOfBirth: { type: Date, default: null },
    address: { type: String, trim: true, maxlength: 240, default: '' },
    city: { type: String, trim: true, maxlength: 80, default: '', index: true },
    emergencyContact: {
      name: { type: String, trim: true, default: '' },
      phone: { type: String, trim: true, default: '' },
    },
    preferences: {
      favouritePhotographerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
      notes: { type: String, trim: true, maxlength: 1000, default: '' },
    },
  },
  { timestamps: true, toJSON: { virtuals: true } },
);

clientProfileSchema.index({ photographerIds: 1, createdAt: -1 });

export type ClientProfile = InferSchemaType<typeof clientProfileSchema>;
export const ClientProfileModel: Model<ClientProfile> =
  (mongoose.models.ClientProfile as Model<ClientProfile>) ??
  model<ClientProfile>('ClientProfile', clientProfileSchema);
