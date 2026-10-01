import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';

const messageSchema = new Schema(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
    photographerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    clientId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    senderRole: { type: String, enum: ['photographer', 'client', 'superadmin'], required: true },

    message: { type: String, required: true, trim: true, maxlength: 4000 },
    /** Text is escaped on render; there are no file attachments by design. */
    read: { type: Boolean, default: false, index: true },
    readAt: { type: Date, default: null },
    editedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, toJSON: { virtuals: true } },
);

messageSchema.index({ conversationId: 1, createdAt: 1 });
messageSchema.index({ conversationId: 1, read: 1, createdAt: -1 });
messageSchema.index({ clientId: 1, read: 1 });

export type Message = InferSchemaType<typeof messageSchema>;
export const MessageModel: Model<Message> =
  (mongoose.models.Message as Model<Message>) ?? model<Message>('Message', messageSchema);
