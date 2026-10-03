import jwt from 'jsonwebtoken';
import type { HydratedDocument } from 'mongoose';
import { GalleryShareModel, ProjectModel, type GalleryShare, type Project } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { AUDIT_ERRORS, SHARE_ERRORS } from '../messages.js';
import { sha256 } from '../utils/crypto.js';
import { env } from '../config/env.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('shares');

/** Shortest token we will even hash. `randomToken` produces far longer. */
const MIN_TOKEN_LENGTH = 20;

/** Access log entries retained per link. */
const ACCESS_LOG_LIMIT = 200;

/**
 * How long an opened gallery may keep being browsed.
 *
 * Long enough to sit on a gallery, select favourites and download, short enough
 * that a forwarded link stops working on its own overnight.
 */
const VIEW_GRANT_TTL_SECONDS = 2 * 60 * 60;

/** Marker so a view grant can never be mistaken for an access token. */
const VIEW_GRANT_TYPE = 'share-view';

export interface ShareVisitor {
  ip?: string;
  userAgent?: string;
}

export interface InspectOptions {
  /**
   * Skip the `maxAccesses` check. Only safe for a caller that already holds a
   * view grant - see `assertShareAccess`.
   */
  ignoreAccessLimit?: boolean;
}

/**
 * Why a token is unusable, or the live share itself.
 *
 * Returned rather than thrown because `/shares/status` has to report the reason
 * to an anonymous visitor instead of erroring.
 */
export async function inspectShare(
  token: unknown,
  options: InspectOptions = {},
): Promise<{ share: HydratedDocument<GalleryShare> | null; reason: string | null }> {
  if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH) {
    return { share: null, reason: SHARE_ERRORS.notFound };
  }

  const share = await GalleryShareModel.findOne({ tokenHash: sha256(token) });
  if (!share || !share.active || share.revokedAt) {
    return { share: null, reason: AUDIT_ERRORS.shareRevoked };
  }
  if (share.expiresAt && share.expiresAt.getTime() < Date.now()) {
    return { share: null, reason: AUDIT_ERRORS.shareExpired };
  }
  if (!options.ignoreAccessLimit && share.maxAccesses > 0 && share.accessCount >= share.maxAccesses) {
    return { share: null, reason: SHARE_ERRORS.limitReached };
  }

  return { share, reason: null };
}

/* -------------------------------------------------------------------------- */
/* View grants                                                                  */
/* -------------------------------------------------------------------------- */

interface ViewGrantPayload {
  typ: typeof VIEW_GRANT_TYPE;
  shareId: string;
  projectId: string;
}

/**
 * Proof that one visitor has already opened one gallery.
 *
 * `maxAccesses` counts gallery *opens*, so without this the first visitor to
 * exhaust a limit would be cut off mid-scroll: they pass the open, the limit is
 * spent, and every thumbnail request after it 403s. The grant separates "may I
 * start browsing?" (limited) from "may I keep browsing?" (held a grant, and the
 * link has not been revoked or expired).
 */
function issueViewGrant(shareId: string, projectId: string): string {
  return jwt.sign(
    { typ: VIEW_GRANT_TYPE, sid: shareId, pid: projectId },
    env.JWT_SECRET,
    { expiresIn: VIEW_GRANT_TTL_SECONDS } as jwt.SignOptions,
  );
}

/** Returns the grant payload, or null if it is missing, forged or expired. */
function verifyViewGrant(grant: unknown): ViewGrantPayload | null {
  if (typeof grant !== 'string' || grant.length === 0) return null;
  try {
    const decoded = jwt.verify(grant, env.JWT_SECRET) as Record<string, unknown>;
    if (decoded.typ !== VIEW_GRANT_TYPE) return null;
    if (typeof decoded.sid !== 'string' || typeof decoded.pid !== 'string') return null;
    return {
      typ: VIEW_GRANT_TYPE,
      shareId: decoded.sid,
      projectId: decoded.pid,
    };
  } catch {
    return null;
  }
}

/**
 * True when `token` is a live link *and* the gallery it points at is published
 * and unexpired. Both are required: a token alone is not access, and neither is
 * publication alone.
 */
export async function isLiveShareForProject(
  projectId: Parameters<typeof ProjectModel.findById>[0],
  token: unknown,
  grant?: unknown,
): Promise<boolean> {
  const view = verifyViewGrant(grant);

  const project = await ProjectModel.findById(projectId)
    .select('gallery.published gallery.expiresAt')
    .lean();
  if (!project?.gallery?.published) return false;
  if (project.gallery.expiresAt && project.gallery.expiresAt.getTime() < Date.now()) return false;

  const { share } = await inspectShare(token, { ignoreAccessLimit: Boolean(view) });
  if (!share) return false;

  // A grant for a different link or a different gallery grants nothing.
  if (view && (view.shareId !== String(share._id) || view.projectId !== String(projectId))) return false;

  return true;
}

/**
 * Records one visit against a link.
 *
 * Deliberately *not* called per rendition fetch. A 60-photo gallery issues 120+
 * image requests, so counting those would exhaust any `maxAccesses` limit on the
 * first page view and fill the access log with duplicates. One visit is counted
 * when someone opens the gallery, which is the event an author means by "access".
 */
export async function recordShareVisit(
  share: HydratedDocument<GalleryShare>,
  visitor: ShareVisitor,
): Promise<void> {
  share.accessCount += 1;
  share.lastAccessedAt = new Date();
  if (!share.firstAccessedAt) share.firstAccessedAt = new Date();

  share.accessLog.push({
    at: new Date(),
    ip: visitor.ip ?? '',
    userAgent: (visitor.userAgent ?? '').slice(0, 300),
  });
  if (share.accessLog.length > ACCESS_LOG_LIMIT) {
    share.accessLog.splice(0, share.accessLog.length - ACCESS_LOG_LIMIT);
  }

  await share.save();
}

/**
 * Resolves a share token to the gallery it may browse, or throws.
 *
 * This is the share-token counterpart to `assertProjectAccess`: it is the one
 * place that decides a non-participant may read a project, which keeps the
 * participant rules in `authorization.ts` from growing a second, weaker code
 * path. Unauthenticated visitors are allowed on purpose - a share link exists
 * precisely so someone outside the booking can be shown the work - but the token
 * is still required and is never sufficient on its own.
 */
export async function assertShareAccess(token: unknown, grant?: unknown): Promise<HydratedDocument<Project>> {
  const view = verifyViewGrant(grant);

  const { share, reason } = await inspectShare(token, { ignoreAccessLimit: Boolean(view) });
  if (!share) throw ApiError.forbidden(reason ?? AUDIT_ERRORS.shareRevoked);

  if (view && (view.shareId !== String(share._id) || view.projectId !== String(share.projectId))) {
    throw ApiError.forbidden(reason ?? AUDIT_ERRORS.shareRevoked);
  }

  const project = await ProjectModel.findById(share.projectId);
  if (!project || !project.gallery?.published) {
    throw ApiError.notFound(AUDIT_ERRORS.noGallery);
  }
  if (project.gallery.expiresAt && project.gallery.expiresAt.getTime() < Date.now()) {
    throw ApiError.forbidden(AUDIT_ERRORS.shareExpired);
  }

  return project;
}

/**
 * Opens a shared gallery: validates the link, confirms it is published, counts
 * one visit, and hands back a view grant so the visitor can keep browsing once
 * the limit is spent.
 */
export async function openSharedGallery(
  token: unknown,
  visitor: ShareVisitor = {},
): Promise<{
  project: HydratedDocument<Project>;
  share: HydratedDocument<GalleryShare>;
  viewToken: string;
}> {
  const { share, reason } = await inspectShare(token);
  if (!share) throw ApiError.forbidden(reason ?? AUDIT_ERRORS.shareRevoked);

  const project = await ProjectModel.findById(share.projectId);
  if (!project || !project.gallery?.published) {
    throw ApiError.notFound(AUDIT_ERRORS.noGallery);
  }
  if (project.gallery.expiresAt && project.gallery.expiresAt.getTime() < Date.now()) {
    throw ApiError.forbidden(AUDIT_ERRORS.shareExpired);
  }

  await recordShareVisit(share, visitor);

  log.debug('share opened', {
    projectId: String(project._id),
    accessCount: share.accessCount,
  });

  return { project, share, viewToken: issueViewGrant(String(share._id), String(project._id)) };
}