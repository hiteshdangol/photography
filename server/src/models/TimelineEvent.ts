import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';

const timelineEventSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    photographerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    clientId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    stage: { type: String, required: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true, maxlength: 1000, default: '' },

    /** `automatic` = emitted by a system trigger, `manual` = photographer override. */
    automatic: { type: Boolean, default: true, index: true },
    /** The trigger that produced this event, e.g. PAYMENT_SUCCEEDED. */
    trigger: { type: String, default: '' },
    /** When the stage was manually overridden, what it was moved from. */
    previousStage: { type: String, default: '' },

    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    occurredAt: { type: Date, default: Date.now, index: true },
    /** Client-facing note; hidden from the client when false. */
    visibleToClient: { type: Boolean, default: true },
  },
  { timestamps: true, toJSON: { virtuals: true } },
);

timelineEventSchema.index({ projectId: 1, occurredAt: 1 });
// One automatic event per stage per project keeps `advance()` idempotent.
timelineEventSchema.index(
  { projectId: 1, stage: 1, automatic: 1 },
  { unique: true, partialFilterExpression: { automatic: true } },
);

export type TimelineEvent = InferSchemaType<typeof timelineEventSchema>;
export const TimelineEventModel: Model<TimelineEvent> =
  (mongoose.models.TimelineEvent as Model<TimelineEvent>) ??
  model<TimelineEvent>('TimelineEvent', timelineEventSchema);
