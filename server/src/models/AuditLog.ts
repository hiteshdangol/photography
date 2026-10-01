import mongoose, { Schema, model, type InferSchemaType, type Model } from 'mongoose';

/**
 * Audit trail. The super admin can see that a booking exists, but should not
 * casually walk into a client's private gallery. Any admin access to a
 * tenant-owned resource must pass through `assertAdminAudit()`, which writes a
 * row here first.
 */
const auditLogSchema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    actorRole: { type: String, required: true },
    action: { type: String, required: true, index: true },

    targetType: { type: String, required: true, index: true },
    targetId: { type: Schema.Types.ObjectId, default: null, index: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    reason: { type: String, trim: true, maxlength: 600, default: '' },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    metadata: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });

export type AuditLog = InferSchemaType<typeof auditLogSchema>;
export const AuditLogModel: Model<AuditLog> =
  (mongoose.models.AuditLog as Model<AuditLog>) ?? model<AuditLog>('AuditLog', auditLogSchema);
