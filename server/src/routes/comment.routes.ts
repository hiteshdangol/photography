import { Router } from 'express';
import { z } from 'zod';
import type { Types } from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created, noContent } from '../utils/response.js';
import { PhotoCommentModel, ProjectModel, UserModel } from '../models/index.js';
import { authenticate } from '../middleware/auth.js';
import { validateBody, validateQuery, q } from '../middleware/validate.js';
import { ApiError } from '../utils/ApiError.js';
import { COMMENT_ERRORS } from '../messages.js';
import { assertPhotoAccess, assertProjectAccess, objectId } from '../services/authorization.js';
import { notify } from '../services/notifications/dispatcher.js';

const router = Router();

const listSchema = z.object({
  photoId: z.string().min(1, 'A photo is required.'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/**
 * Comments on one photo, as a single-level thread.
 *
 * Access follows the photo, not the comment: `assertPhotoAccess` decides who is
 * allowed to read the thread, so there is no way to ask "give me the comments of
 * photo X" and learn about a photo the caller cannot see.
 */
router.get(
  '/',
  authenticate,
  validateQuery(listSchema),
  asyncHandler(async (req, res) => {
    const filters = q<z.infer<typeof listSchema>>(req);
    const photo = await assertPhotoAccess(filters.photoId, req.ctx);

    const rows = await PhotoCommentModel.find({ photoId: photo._id })
      .sort({ createdAt: 1 })
      .limit(filters.limit)
      .lean();
    const authors = await loadAuthors(rows.map((r) => r.userId));

    return ok(res, {
      comments: rows.map((row) => toCommentDto(row, authors.get(String(row.userId)), req.ctx.userId)),
      total: rows.length,
    });
  }),
);

const createSchema = z.object({
  photoId: z.string().min(1),
  comment: z.string().trim().min(1, 'Write something first.').max(2000),
  parentId: z.string().optional(),
});

/**
 * Post a comment or a reply.
 *
 * The reply target must exist on the *same photo*, otherwise a crafted parentId
 * would let someone graft their reply onto an unrelated thread.
 */
router.post(
  '/',
  authenticate,
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const photo = await assertPhotoAccess(req.body.photoId, req.ctx);

    let parentId: Types.ObjectId | null = null;
    if (req.body.parentId) {
      const parent = await PhotoCommentModel.findOne({
        _id: objectId(req.body.parentId, 'parent comment id'),
        photoId: photo._id,
      })
        .select('_id')
        .lean();
      if (!parent) throw ApiError.badRequest('That comment is not on this photo.');
      parentId = parent._id;
    }

    const row = await PhotoCommentModel.create({
      photoId: photo._id,
      projectId: photo.projectId,
      photographerId: photo.photographerId,
      userId: req.ctx.userId,
      userRole: req.ctx.role,
      parentId,
      comment: req.body.comment,
    });

    // The conversation is two-sided, so the "other party" is whoever did not
    // write this comment. Replying to your own comment never pings yourself.
    const recipientId =
      String(req.ctx.userId) === String(photo.photographerId)
        ? photo.clientId
        : photo.photographerId;
    if (parentId === null && recipientId) {
      await notify({
        userId: recipientId,
        photographerId: photo.photographerId,
        projectId: photo.projectId,
        type: 'comment_added',
        title: req.ctx.role === 'photographer' ? 'New comment from your studio' : 'New comment on your photo',
        message: `${req.ctx.role === 'photographer' ? 'A photographer' : 'Your photographer'} commented: ${truncate(req.body.comment, 90)}`,
        link: `/projects/${String(photo.projectId)}/photos/${String(photo._id)}`,
        priority: 'normal',
        email: req.ctx.role === 'client',
      });
    }

    return created(
      res,
      { comment: toCommentDto(row.toObject(), await loadAuthor(req.ctx.userId), req.ctx.userId) },
      'Comment posted.',
    );
  }),
);

router.patch(
  '/:id',
  authenticate,
  validateBody(z.object({ comment: z.string().trim().min(1).max(2000) })),
  asyncHandler(async (req, res) => {
    const row = await PhotoCommentModel.findById(objectId(req.params.id, 'comment id'));
    if (!row) throw ApiError.notFound(COMMENT_ERRORS.notFound);
    if (String(row.userId) !== String(req.ctx.userId) && req.ctx.role !== 'superadmin') {
      throw ApiError.forbidden(COMMENT_ERRORS.notYours);
    }

    row.comment = req.body.comment;
    row.editedAt = new Date();
    await row.save();

    return ok(res, { comment: toCommentDto(row.toObject(), await loadAuthor(req.ctx.userId), req.ctx.userId) }, 'Comment updated.');
  }),
);

router.delete(
  '/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    const row = await PhotoCommentModel.findById(objectId(req.params.id, 'comment id'));
    if (!row) throw ApiError.notFound(COMMENT_ERRORS.notFound);

    // The author can always delete their own words; the owning photographer can
    // moderate the thread on their project; a client cannot delete the studio's
    // replies. Anything else gets a 404 rather than a hint that the row exists.
    const isAuthor = String(row.userId) === String(req.ctx.userId);
    const isOwner =
      req.ctx.role === 'superadmin' ||
      (req.ctx.role === 'photographer' && String(row.photographerId) === String(req.ctx.tenantId));
    if (!isAuthor && !isOwner) throw ApiError.notFound(COMMENT_ERRORS.notFound);

    await row.deleteOne();
    return noContent(res, 'Comment deleted.');
  }),
);

/** Mark every unread comment on a project as read. Drives the unread badge. */
router.post(
  '/read',
  authenticate,
  validateBody(z.object({ projectId: z.string().min(1) })),
  asyncHandler(async (req, res) => {
    const projectId = objectId(req.body.projectId, 'project id');
    await assertProjectAccess(projectId, req.ctx);

    // Only the *other* party's comments are unread for the caller; marking your
    // own words as read would clear a badge that was never showing.
    const result = await PhotoCommentModel.updateMany(
      { projectId, userId: { $ne: req.ctx.userId }, read: false },
      { $set: { read: true, readAt: new Date() } },
    );
    return ok(res, { updated: result.modifiedCount }, 'Comments marked as read.');
  }),
);

/**
 * Unread counts for the dashboard badges, in one round trip.
 */
router.get(
  '/unread/counts',
  authenticate,
  asyncHandler(async (req, res) => {
    let filter: Record<string, unknown> = {};
    if (req.ctx.role === 'photographer') {
      filter = { photographerId: req.ctx.tenantId, userId: { $ne: req.ctx.userId }, read: false };
    } else if (req.ctx.role === 'client') {
      const projects = await ProjectModel.find({ clientId: req.ctx.userId }).select('_id').lean();
      filter = {
        projectId: { $in: projects.map((p) => p._id) },
        userId: { $ne: req.ctx.userId },
        read: false,
      };
    }

    const grouped = await PhotoCommentModel.aggregate([
      { $match: filter },
      { $group: { _id: '$projectId', count: { $sum: 1 } } },
    ]);

    return ok(res, {
      total: grouped.reduce((sum, g) => sum + g.count, 0),
      byProject: grouped.map((g) => ({ projectId: String(g._id), count: g.count })),
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

type CommentRow = {
  _id: unknown;
  photoId: unknown;
  parentId?: unknown;
  comment: string;
  userId: unknown;
  userRole: string;
  read: boolean;
  createdAt: Date;
  updatedAt?: Date;
  editedAt?: Date | null;
};

type Author = { name: string; avatar: string | null | undefined };

function toCommentDto(row: CommentRow, author: Author | undefined, viewerId: unknown) {
  return {
    id: String(row._id),
    photoId: String(row.photoId),
    parentId: row.parentId ? String(row.parentId) : null,
    comment: row.comment,
    userRole: row.userRole,
    isMine: String(row.userId) === String(viewerId),
    author: author
      ? { name: author.name, avatar: author.avatar ?? '' }
      : { name: 'Deleted user', avatar: '' },
    read: row.read,
    editedAt: row.editedAt,
    createdAt: row.createdAt,
  };
}

async function loadAuthor(userId: unknown): Promise<Author | undefined> {
  const user = await UserModel.findById(userId).select('name avatar').lean();
  return user ? { name: user.name, avatar: user.avatar } : undefined;
}

async function loadAuthors(userIds: unknown[]): Promise<Map<string, Author>> {
  const unique = [...new Set(userIds.map(String))];
  const users = await UserModel.find({ _id: { $in: unique } }).select('name avatar').lean();
  return new Map(users.map((u) => [String(u._id), { name: u.name, avatar: u.avatar }]));
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}\u2026`;
}

export default router;
