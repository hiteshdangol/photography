import type { Request } from 'express';
import { Types } from 'mongoose';
import { AuditLogModel } from '../models/index.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('audit');

/** Anything the audit helper can resolve to a stored target id. */
type AuditTarget = Types.ObjectId | string | { _id?: Types.ObjectId } | null | undefined;

function resolveTargetId(target: AuditTarget): Types.ObjectId | null {
  if (!target) return null;
  if (typeof target === 'string') return new Types.ObjectId(target);
  if (target instanceof Types.ObjectId) return target;
  return (target as { _id?: Types.ObjectId })._id ?? null;
}

/**
 * Records a platform-level administrative action.
 *
 * Used for every superadmin mutation (suspend a photographer, void an invoice,
 * edit the platform settings...). Keeps the promise that admin activity is
 * always attributable and reviewable.
 */
export async function adminAudit(
  req: Request,
  action: string,
  targetType: string,
  targetId?: AuditTarget,
  extra: { reason?: string; metadata?: Record<string, unknown> } = {},
): Promise<void> {
  if (!req.ctx) return;
  try {
    await AuditLogModel.create({
      actorId: req.ctx.userId,
      actorRole: req.ctx.role,
      action,
      targetType,
      targetId: resolveTargetId(targetId),
      tenantId: resolveTargetId(extra.metadata?.tenantId as AuditTarget),
      reason: extra.reason ?? '',
      metadata: extra.metadata ?? null,
      ip: req.ip ?? '',
      userAgent: (req.headers['user-agent'] ?? '').slice(0, 300),
    });
  } catch (error) {
    log.warn('failed to write audit log', {
      action,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
