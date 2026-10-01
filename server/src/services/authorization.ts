import type { Types } from 'mongoose';
import { Types as MongooseTypes } from 'mongoose';
import type { HydratedDocument } from 'mongoose';
import type { AccessOptions, RequestContext } from '../types/express.js';
import { ApiError } from '../utils/ApiError.js';
import { AUDIT_ERRORS } from '../messages.js';
import {
  AlbumModel,
  BookingModel,
  PhotoModel,
  ProjectModel,
  AuditLogModel,
  type Album,
  type Booking,
  type Photo,
  type Project,
} from '../models/index.js';
import { env } from '../config/env.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('authz');

type Doc<T> = HydratedDocument<T>;

/* -------------------------------------------------------------------------- */
/* Query scoping                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The tenant filter every protected query MUST include.
 *
 * Photographers are pinned to their own records. Clients are pinned to records
 * they own. The super admin gets an empty filter on purpose: admin listing
 * endpoints read across tenants, but any attempt to read a *specific* tenant
 * resource still has to go through `assertProjectAccess` and state a reason.
 */
export function tenantFilter(ctx: RequestContext): Record<string, unknown> {
  if (ctx.role === 'photographer') {
    return { photographerId: ctx.tenantId };
  }
  if (ctx.role === 'client') {
    return { clientId: ctx.userId };
  }
  return {};
}

/**
 * Reject any request that tries to act on behalf of a different tenant, even if
 * it is merely echoing the id back. Catches accidental cross-tenant writes and
 * confused-deputy attempts early, with a clear message.
 */
export function assertSameTenant(ctx: RequestContext, claimedTenantId: unknown): void {
  if (claimedTenantId === undefined || claimedTenantId === null || claimedTenantId === '') return;
  if (ctx.role === 'superadmin') return;
  if (ctx.role !== 'photographer') {
    throw ApiError.forbidden(AUDIT_ERRORS.crossTenant);
  }
  if (String(claimedTenantId) !== String(ctx.tenantId)) {
    log.warn('blocked cross-tenant request', {
      userId: String(ctx.userId),
      claimed: String(claimedTenantId),
    });
    throw ApiError.forbidden(AUDIT_ERRORS.crossTenant);
  }
}

/* -------------------------------------------------------------------------- */
/* Object id parsing                                                           */
/* -------------------------------------------------------------------------- */

export function objectId(value: unknown, label = 'id'): Types.ObjectId {
  if (value instanceof MongooseTypes.ObjectId) return value;
  if (typeof value === 'string' && MongooseTypes.ObjectId.isValid(value)) {
    return new MongooseTypes.ObjectId(value);
  }
  throw ApiError.badRequest(`Invalid ${label}.`);
}

export function optionalObjectId(value: unknown): Types.ObjectId | null {
  if (value === undefined || value === null || value === '') return null;
  return objectId(value);
}

/* -------------------------------------------------------------------------- */
/* Audit                                                                       */
/* -------------------------------------------------------------------------- */

export async function assertAdminAudit(
  ctx: RequestContext,
  options: AccessOptions,
  meta: { targetType: string; targetId?: Types.ObjectId; tenantId?: Types.ObjectId | null },
): Promise<void> {
  if (ctx.role !== 'superadmin') return;
  if (!options.adminAudit) {
    throw ApiError.forbidden(
      'Administrative access to this resource must be justified with an access reason.',
    );
  }
  await AuditLogModel.create({
    actorId: ctx.userId,
    actorRole: ctx.role,
    action: 'admin_resource_access',
    targetType: meta.targetType,
    targetId: meta.targetId ?? null,
    tenantId: meta.tenantId ?? null,
    reason: options.adminAudit,
    metadata: { sessionId: ctx.sessionId },
  });
  log.warn('admin accessed a tenant resource', {
    admin: String(ctx.userId),
    target: `${meta.targetType}:${String(meta.targetId ?? '-')}`,
    reason: options.adminAudit,
  });
}

/* -------------------------------------------------------------------------- */
/* Project access - the one place this decision is made                        */
/* -------------------------------------------------------------------------- */

export type ProjectRelation = 'owner' | 'client' | 'admin';

export function projectRelation(ctx: RequestContext, project: Project): ProjectRelation | null {
  if (ctx.role === 'photographer' && String(project.photographerId) === String(ctx.tenantId)) {
    return 'owner';
  }
  if (ctx.role === 'client' && String(project.clientId) === String(ctx.userId)) {
    return 'client';
  }
  return null;
}

/**
 * The authorization choke point.
 *
 * Photos, albums, favourites, selections, comments, downloads, gallery shares
 * and chat all funnel through here (directly or via `assertPhotoAccess` /
 * `assertAlbumAccess`). A resource that is reachable by any route has been
 * checked here, which is what makes cross-tenant access structurally
 * impossible rather than "remembered correctly in 40 controllers".
 */
export async function assertProjectAccess(
  projectId: unknown,
  ctx: RequestContext,
  options: AccessOptions = {},
): Promise<Doc<Project>> {
  const id = objectId(projectId, 'project id');
  const project = await ProjectModel.findById(id);
  if (!project) throw ApiError.notFound('That project does not exist.');

  const relation = projectRelation(ctx, project);
  if (relation) {
    // A client can always see their own project; a photographer always sees
    // their own project regardless of publication state.
    return project;
  }

  if (ctx.role === 'superadmin') {
    await assertAdminAudit(ctx, options, {
      targetType: 'Project',
      targetId: project._id,
      tenantId: project.photographerId as Types.ObjectId,
    });
    return project;
  }

  log.warn('denied project access', {
    userId: String(ctx.userId),
    role: ctx.role,
    projectId: String(id),
  });
  // 404 rather than 403: a stranger should not be able to probe which project
  // ids exist.
  throw ApiError.notFound('That project does not exist.');
}

export async function assertPhotoAccess(
  photoId: unknown,
  ctx: RequestContext,
  options: AccessOptions = {},
): Promise<Doc<Photo>> {
  const id = objectId(photoId, 'photo id');
  const photo = await PhotoModel.findById(id);
  if (!photo) throw ApiError.notFound('That photo does not exist.');

  // Fast path: the owning photographer, without a second query.
  if (ctx.role === 'photographer' && String(photo.photographerId) === String(ctx.tenantId)) {
    return photo;
  }
  if (ctx.role === 'client' && String(photo.clientId) === String(ctx.userId)) {
    return photo;
  }

  await assertProjectAccess(photo.projectId, ctx, options);
  return photo;
}

export async function assertAlbumAccess(
  albumId: unknown,
  ctx: RequestContext,
  options: AccessOptions = {},
): Promise<Doc<Album>> {
  const id = objectId(albumId, 'album id');
  const album = await AlbumModel.findById(id);
  if (!album) throw ApiError.notFound('That album does not exist.');

  if (ctx.role === 'photographer' && String(album.photographerId) === String(ctx.tenantId)) {
    return album;
  }
  if (ctx.role === 'client' && String(album.clientId) === String(ctx.userId)) {
    return album;
  }

  await assertProjectAccess(album.projectId, ctx, options);
  return album;
}

export async function assertBookingAccess(
  bookingId: unknown,
  ctx: RequestContext,
  options: AccessOptions = {},
): Promise<Doc<Booking>> {
  const id = objectId(bookingId, 'booking id');
  const booking = await BookingModel.findById(id);
  if (!booking) throw ApiError.notFound('That booking does not exist.');

  if (ctx.role === 'photographer' && String(booking.photographerId) === String(ctx.tenantId)) {
    return booking;
  }
  if (ctx.role === 'client' && String(booking.clientId) === String(ctx.userId)) {
    return booking;
  }

  await assertAdminAudit(ctx, options, {
    targetType: 'Booking',
    targetId: booking._id,
    tenantId: booking.photographerId as Types.ObjectId,
  });
  return booking;
}

/**
 * Photographer-only guard for actions that change a tenant's business data.
 * Separate from `assertProjectAccess` because "is this mine?" and "may I mutate
 * it?" are different questions - a client can read a project they cannot edit.
 */
export function assertTenantOwner(ctx: RequestContext, ownerPhotographerId: unknown): void {
  if (ctx.role !== 'photographer') {
    throw ApiError.forbidden('Only the photographer can perform this action.');
  }
  if (String(ownerPhotographerId) !== String(ctx.tenantId)) {
    throw ApiError.forbidden(AUDIT_ERRORS.crossTenant);
  }
}

export function assertRole(ctx: RequestContext, ...roles: RequestContext['role'][]): void {
  if (!roles.includes(ctx.role)) {
    throw ApiError.forbidden('Your account does not have access to this feature.');
  }
}

export function assertPhotographer(ctx: RequestContext): Types.ObjectId {
  if (ctx.role !== 'photographer' || !ctx.tenantId) {
    throw ApiError.forbidden('Only a photographer account can do that.');
  }
  return ctx.tenantId;
}

export function assertClient(ctx: RequestContext): Types.ObjectId {
  if (ctx.role !== 'client') {
    throw ApiError.forbidden('Only a client account can do that.');
  }
  return ctx.userId;
}

export { env };
