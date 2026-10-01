import type { Types } from 'mongoose';
import type { UserRole } from '../config/constants.js';

/**
 * The authenticated caller's identity, derived *only* from a verified JWT.
 * Nothing in here ever comes from a request body, query string or param.
 */
export interface RequestContext {
  userId: Types.ObjectId;
  role: UserRole;
  email: string;
  /**
   * The tenant this request operates inside: the photographer's own user id.
   * `null` for clients (who span tenants) and for the super admin.
   */
  tenantId: Types.ObjectId | null;
  sessionId: string;
}

export interface AccessOptions {
  /**
   * Required when a superadmin reads a tenant-owned resource. Writes an
   * AuditLog row. Omitting it for a superadmin is a 403 - there is no silent
   * admin bypass of private client data.
   */
  adminAudit?: string;
  /** Allow access to a project the photographer owns but has not published. */
  requirePublished?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      ctx: RequestContext;
      requestId?: string;
    }
  }
}

export {};
