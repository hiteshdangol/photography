import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, noContent } from '../utils/response.js';
import { NotificationModel } from '../models/index.js';
import { authenticate } from '../middleware/auth.js';
import { validateBody, validateQuery, q } from '../middleware/validate.js';
import { ApiError } from '../utils/ApiError.js';
import { objectId } from '../services/authorization.js';
import { emitToUser, isIoReady } from '../sockets/emitter.js';

const router = Router();

const listSchema = z.object({
  unreadOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  type: z.string().trim().max(60).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/**
 * The caller's notification feed.
 *
 * Every query is pinned to `userId: req.ctx.userId`. There is no admin variant
 * here on purpose - reading another user's notifications is not a feature, it is
 * a data leak, and platform-wide visibility belongs in the analytics surface
 * instead.
 */
router.get(
  '/',
  authenticate,
  validateQuery(listSchema),
  asyncHandler(async (req, res) => {
    const filters = q<z.infer<typeof listSchema>>(req);
    const filter: Record<string, unknown> = { userId: req.ctx.userId };
    if (filters.unreadOnly) filter.read = false;
    if (filters.type) filter.type = filters.type;

    const skip = (filters.page - 1) * filters.limit;
    const [items, total, unread] = await Promise.all([
      NotificationModel.find(filter as { userId: typeof req.ctx.userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(filters.limit)
        .lean(),
      NotificationModel.countDocuments(filter as { userId: typeof req.ctx.userId }),
      NotificationModel.countDocuments({ userId: req.ctx.userId, read: false }),
    ]);

    return ok(res, {
      notifications: items.map((n) => toDto(n)),
      unread,
      pagination: {
        page: filters.page,
        limit: filters.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / filters.limit)),
      },
    });
  }),
);

/** Badge count only. Cheap enough to poll. */
router.get(
  '/unread/count',
  authenticate,
  asyncHandler(async (req, res) => {
    const count = await NotificationModel.countDocuments({ userId: req.ctx.userId, read: false });
    return ok(res, { unread: count });
  }),
);

router.patch(
  '/:id/read',
  authenticate,
  asyncHandler(async (req, res) => {
    // The userId in the filter is what makes this safe: a guessed id belonging to
    // someone else simply matches nothing and 404s.
    const notification = await NotificationModel.findOneAndUpdate(
      { _id: objectId(req.params.id, 'notification id'), userId: req.ctx.userId },
      { $set: { read: true, readAt: new Date() } },
      { new: true },
    ).lean();
    if (!notification) throw ApiError.notFound('That notification does not exist.');

    return ok(res, { notification: toDto(notification) }, 'Marked as read.');
  }),
);

router.post(
  '/read-all',
  authenticate,
  validateBody(z.object({ ids: z.array(z.string()).max(200).optional() }).optional()),
  asyncHandler(async (req, res) => {
    const ids = req.body?.ids?.map((id: string) => objectId(id, 'notification id'));
    const filter: { userId: typeof req.ctx.userId; read: boolean; _id?: { $in: typeof ids } } = {
      userId: req.ctx.userId,
      read: false,
    };
    if (ids && ids.length > 0) filter._id = { $in: ids };

    const result = await NotificationModel.updateMany(filter, {
      $set: { read: true, readAt: new Date() },
    });

    const unread = await NotificationModel.countDocuments({ userId: req.ctx.userId, read: false });
    return ok(res, { updated: result.modifiedCount, unread }, 'Notifications cleared.');
  }),
);

/**
 * Remove one notification.
 *
 * Only from the caller's own feed, and only the row - nothing else references a
 * notification, so deleting is safe where an "archive" flag would not be.
 */
router.delete(
  '/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    const result = await NotificationModel.deleteOne({
      _id: objectId(req.params.id, 'notification id'),
      userId: req.ctx.userId,
    });
    if (result.deletedCount === 0) throw ApiError.notFound('That notification does not exist.');

    emitToUser(String(req.ctx.userId), 'notification:removed', { id: req.params.id });
    return noContent(res, 'Notification removed.');
  }),
);

/**
 * Realtime subscription.
 *
 * Socket.IO authenticates with the same access token as the REST API and joins a
 * per-user room, so this route only reports what the socket is already wired for.
 * Kept as an explicit endpoint so the client has one place to confirm the
 * channel is live rather than assuming a socket implies push.
 */
router.get(
  '/stream/status',
  authenticate,
  asyncHandler(async (req, res) => {
    // The REST layer cannot see the caller's socket, so this reports whether the
    // Socket.IO server is attached at all - not whether this user is subscribed.
    return ok(res, {
      channel: `user:${String(req.ctx.userId)}`,
      serverReady: isIoReady(),
    });
  }),
);

/* -------------------------------------------------------------------------- */

/** Only the fields the DTO reads, so hydrated documents and lean results both fit. */
type NotificationShape = {
  _id: unknown;
  type: string;
  title: string;
  message?: string;
  link?: string;
  read?: boolean;
  priority?: string;
  bookingId?: unknown;
  projectId?: unknown;
  paymentId?: unknown;
  invoiceId?: unknown;
  createdAt: Date;
};

/**
 * Email delivery state is internal bookkeeping and is not returned - a client has
 * no use for "SMTP bounced", and it leaks infrastructure detail.
 */
function toDto(n: NotificationShape) {
  return {
    id: String(n._id),
    type: n.type,
    title: n.title,
    message: n.message ?? '',
    link: n.link ?? '',
    read: n.read ?? false,
    priority: n.priority ?? 'normal',
    bookingId: n.bookingId ? String(n.bookingId) : null,
    projectId: n.projectId ? String(n.projectId) : null,
    paymentId: n.paymentId ? String(n.paymentId) : null,
    invoiceId: n.invoiceId ? String(n.invoiceId) : null,
    createdAt: n.createdAt,
  };
}

export default router;
