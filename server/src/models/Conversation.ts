import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';

/**
 * A client <-> photographer thread. A conversation is always scoped to a
 * tenant pair (photographerId + clientId) and optionally to a project.
 *
 * `projectKey` is a plain string ('' for a general thread) rather than a
 * nullable `projectId` because MongoDB treats a missing index key as null, and
 * two null values in a unique index are treated as duplicates - which would
 * silently block every general thread after the first.
 */
const conversationSchema = new Schema(
  {
    photographerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    clientId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null, index: true },
    projectKey: { type: String, default: '' },

    lastMessageAt: { type: Date, default: Date.now, index: true },
    lastMessagePreview: { type: String, default: '' },
    lastMessageSenderId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    messageCount: { type: Number, default: 0 },

    /** Per-participant unread counters, so a badge never needs a message scan. */
    unread: {
      type: new Schema(
        {
          photographer: { type: Number, default: 0, min: 0 },
          client: { type: Number, default: 0, min: 0 },
        },
        { _id: false },
      ),
      required: true,
      default: () => ({ photographer: 0, client: 0 }),
    },
  },
  { timestamps: true, toJSON: { virtuals: true } },
);

conversationSchema.index({ photographerId: 1, clientId: 1, projectKey: 1 }, { unique: true });
conversationSchema.index({ photographerId: 1, lastMessageAt: -1 });
conversationSchema.index({ clientId: 1, lastMessageAt: -1 });

export type Conversation = InferSchemaType<typeof conversationSchema>;
export const ConversationModel: Model<Conversation> =
  (mongoose.models.Conversation as Model<Conversation>) ?? model<Conversation>('Conversation', conversationSchema);
