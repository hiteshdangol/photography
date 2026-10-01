import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';

const windowSchema = new Schema(
  {
    start: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    end: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  },
  { _id: false },
);

/** Recurring weekly working pattern. `dayOfWeek` 0=Sunday .. 6=Saturday. */
const availabilityRuleSchema = new Schema(
  {
    photographerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    dayOfWeek: { type: Number, min: 0, max: 6, required: true },
    windows: { type: [windowSchema], default: [] },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

availabilityRuleSchema.index({ photographerId: 1, dayOfWeek: 1 }, { unique: true });

/** A concrete date the photographer is unavailable (holiday, personal, etc). */
const availabilityBlockSchema = new Schema(
  {
    photographerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Inclusive range of blocked dates, stored as UTC midnight. */
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    allDay: { type: Boolean, default: true },
    /** Optional partial-day block, e.g. 14:00-18:00 on 2026-09-15. */
    windows: { type: [windowSchema], default: [] },
    reason: { type: String, trim: true, maxlength: 200, default: '' },
  },
  { timestamps: true },
);

availabilityBlockSchema.index({ photographerId: 1, startDate: 1, endDate: 1 });

export type AvailabilityRule = InferSchemaType<typeof availabilityRuleSchema>;
export type AvailabilityBlock = InferSchemaType<typeof availabilityBlockSchema>;

export const AvailabilityRuleModel: Model<AvailabilityRule> =
  (mongoose.models.AvailabilityRule as Model<AvailabilityRule>) ??
  model<AvailabilityRule>('AvailabilityRule', availabilityRuleSchema);

export const AvailabilityBlockModel: Model<AvailabilityBlock> =
  (mongoose.models.AvailabilityBlock as Model<AvailabilityBlock>) ??
  model<AvailabilityBlock>('AvailabilityBlock', availabilityBlockSchema);
