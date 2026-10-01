import { Router } from 'express';
import { z } from 'zod';
import type { Types } from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created, noContent } from '../utils/response.js';
import {
  ClientProfileModel,
  ConversationModel,
  MessageModel,
  ProjectModel,
  UserModel,
} from '../models/index.js';
import { authenticate } from '../middleware/auth.js';
import { validateBody, validateQuery, q } from '../middleware/validate.js';
import { ApiError } from '../utils/ApiError.js';
import { CHAT_ERRORS } from '../messages.js';
import { objectId } from '../services/authorization.js';
import { emitToConversation, emitToUser } from '../sockets/emitter.js';
import { notify } from '../services/notifications/dispatcher.js';
import type { RequestContext } from '../types/express.js';

const router = Router();

/* -------------------------------------------------------------------------- */
/* Conversations                                                               */
/* -------------------------------------------------------------------------- */

const listSchema = z.object({
  projectId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});

/**
 * The caller's threads, newest activity first.
 *
 * A conversation is always between exactly two users, so the filter is built
 * from the caller's own id on one side or the other. There is no way to ask for
 * "all conversations" as a client.
 */
router.get(
  '/conversations',
  authenticate,
  validateQuery(listSchema),
  asyncHandler(async (req, res) => {
    const filters = q<z.infer<typeof listSchema>>(req);
    const filter = participantFilter(req.ctx);
    if (filters.projectId) filter.projectId = objectId(filters.projectId, 'project id');

    const conversations = await ConversationModel.find(filter)
      .sort({ lastMessageAt: -1 })
      .limit(filters.limit)
      .lean();

    const counterpartIds = conversations.map((c) => counterpartOf(c, req.ctx));
    const counterparts = await UserModel.find({ _id: { $in: [...new Set(counterpartIds.map(String))] } })
      .select('name avatar role')
      .lean();
    const byId = new Map(counterparts.map((u) => [String(u._id), u]));

    return ok(res, {
      conversations: conversations.map((c) => {
        const other = byId.get(String(counterpartOf(c, req.ctx)));
        return {
          id: String(c._id),
          projectId: c.projectId ? String(c.projectId) : null,
          counterpart: other
            ? { id: String(other._id), name: other.name, avatar: other.avatar, role: other.role }
            : null,
          lastMessageAt: c.lastMessageAt,
          preview: c.lastMessagePreview,
          messageCount: c.messageCount,
          unread: unreadFor(c, req.ctx),
        };
      }),
    });
  }),
);

const startSchema = z.object({
  /** The other party. Must be either the tenant or one of their clients. */
  recipientId: z.string().min(1),
  projectId: z.string().optional(),
  message: z.string().trim().min(1, 'Write a message first.').max(4000).optional(),
});

/**
 * Start a thread, or return the existing one.
 *
 * Re-opening is the normal path (a client tapping "message your photographer"
 * twice should not create two threads), which is why the unique index on
 * (photographerId, clientId, projectKey) is the source of truth for identity
 * rather than whatever the client believes.
 */
router.post(
  '/conversations',
  authenticate,
  validateBody(startSchema),
  asyncHandler(async (req, res) => {
    const pair = await resolvePair(req.ctx, req.body.recipientId, req.body.projectId);

    const existing = await ConversationModel.findOne({
      photographerId: pair.photographerId,
      clientId: pair.clientId,
      projectKey: pair.projectKey,
    });
    if (existing) return ok(res, { conversation: toConversationDto(existing, req.ctx) }, 'Conversation already open.');

    const conversation = await ConversationModel.create({
      photographerId: pair.photographerId,
      clientId: pair.clientId,
      projectId: pair.projectId,
      projectKey: pair.projectKey,
    });

    if (req.body.message) {
      await appendMessage(conversation, req.ctx, req.body.message);
    }

    return created(res, { conversation: toConversationDto(conversation, req.ctx) }, 'Conversation started.');
  }),
);

router.get(
  '/conversations/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    const conversation = await assertParticipant(req.params.id, req.ctx);
    return ok(res, { conversation: toConversationDto(conversation, req.ctx) });
  }),
);

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

const messagesSchema = z.object({
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});

/**
 * Message history, oldest-first, paginated backwards via `?before=<id>`.
 *
 * Reading a thread also marks it read. Doing it here rather than in a separate
 * endpoint is what keeps the unread badge honest: a badge that only clears on an
 * explicit "mark read" click stays lit forever if the user just scrolls away.
 */
router.get(
  '/conversations/:id/messages',
  authenticate,
  validateQuery(messagesSchema),
  asyncHandler(async (req, res) => {
    const filters = q<z.infer<typeof messagesSchema>>(req);
    const conversation = await assertParticipant(req.params.id, req.ctx);

    const filter: Record<string, unknown> = { conversationId: conversation._id, deletedAt: null };
    if (filters.before) {
      const cursor = await MessageModel.findById(objectId(filters.before, 'message id')).select('createdAt').lean();
      if (cursor) filter.createdAt = { $lt: cursor.createdAt };
    }

    const rows = await MessageModel.find(filter)
      .sort({ createdAt: -1 })
      .limit(filters.limit)
      .lean();

    const oldest = rows[rows.length - 1];
    await markRead(conversation, req.ctx);

    return ok(res, {
      messages: rows.reverse().map((m) => toMessageDto(m, req.ctx)),
      hasMore: rows.length === filters.limit,
      nextBefore: oldest ? String(oldest._id) : null,
    });
  }),
);

const sendSchema = z.object({
  message: z.string().trim().min(1, 'Write something first.').max(4000),
});

/**
 * Send a message.
 *
 * Persisted first, then broadcast. Emitting before the write would let a
 * reconnecting client fetch history and find the message missing; writing first
 * means a slow socket can never show something the database does not have.
 */
router.post(
  '/conversations/:id/messages',
  authenticate,
  validateBody(sendSchema),
  asyncHandler(async (req, res) => {
    const conversation = await assertParticipant(req.params.id, req.ctx);
    const message = await appendMessage(conversation, req.ctx, req.body.message);
    return created(res, { message: toMessageDto(message, req.ctx) }, 'Message sent.');
  }),
);

router.patch(
  '/messages/:id',
  authenticate,
  validateBody(z.object({ message: z.string().trim().min(1).max(4000) })),
  asyncHandler(async (req, res) => {
    const message = await MessageModel.findById(objectId(req.params.id, 'message id'));
    if (!message || message.deletedAt) throw ApiError.notFound(CHAT_ERRORS.notFound);
    if (String(message.senderId) !== String(req.ctx.userId)) {
      throw ApiError.forbidden(CHAT_ERRORS.notYours);
    }

    message.message = req.body.message;
    message.editedAt = new Date();
    await message.save();

    emitToConversation(String(message.conversationId), 'chat:updated', {
      id: String(message._id),
      message: message.message,
      editedAt: message.editedAt,
    });

    return ok(res, { message: toMessageDto(message, req.ctx) }, 'Message updated.');
  }),
);

/**
 * Soft delete. The row stays so the thread's ordering does not shift under the
 * other participant, but the text is removed and the placeholder is neutral.
 */
router.delete(
  '/messages/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    const message = await MessageModel.findById(objectId(req.params.id, 'message id'));
    if (!message || message.deletedAt) throw ApiError.notFound(CHAT_ERRORS.notFound);

    const canModerate =
      req.ctx.role === 'superadmin' ||
      (req.ctx.role === 'photographer' && String(message.photographerId) === String(req.ctx.tenantId));
    if (String(message.senderId) !== String(req.ctx.userId) && !canModerate) {
      throw ApiError.notFound(CHAT_ERRORS.notFound);
    }

    message.message = '';
    message.deletedAt = new Date();
    await message.save();

    emitToConversation(String(message.conversationId), 'chat:deleted', { id: String(message._id) });
    return noContent(res, 'Message deleted.');
  }),
);

router.post(
  '/conversations/:id/read',
  authenticate,
  asyncHandler(async (req, res) => {
    const conversation = await assertParticipant(req.params.id, req.ctx);
    await markRead(conversation, req.ctx);
    return ok(res, { read: true });
  }),
);

/** Total unread across every thread, for the header badge. */
router.get(
  '/unread',
  authenticate,
  asyncHandler(async (req, res) => {
    const conversations = await ConversationModel.find(participantFilter(req.ctx)).select('unread').lean();
    const total = conversations.reduce((sum, c) => sum + unreadFor(c, req.ctx), 0);
    return ok(res, { total, threads: conversations.filter((c) => unreadFor(c, req.ctx) > 0).length });
  }),
);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Who can this caller talk to?
 *
 * A client may only open a thread with the photographer they already have a
 * relationship with; a photographer may only open one with an existing client.
 * Without this check, any signed-in user could start a thread with any other
 * user id and use the platform as a messaging relay to strangers.
 */
async function resolvePair(
  ctx: RequestContext,
  recipientId: string,
  projectId?: string,
): Promise<{
  photographerId: Types.ObjectId;
  clientId: Types.ObjectId;
  projectId: Types.ObjectId | null;
  projectKey: string;
}> {
  const recipient = objectId(recipientId, 'recipient id');

  let project: { _id: Types.ObjectId; photographerId: Types.ObjectId; clientId: Types.ObjectId } | null = null;
  if (projectId) {
    project = await ProjectModel.findById(projectId).select('_id photographerId clientId').lean();
    if (!project) throw ApiError.notFound(CHAT_ERRORS.notParticipant);

    const isParty =
      String(project.photographerId) === String(ctx.tenantId) || String(project.clientId) === String(ctx.userId);
    if (!isParty) throw ApiError.notFound(CHAT_ERRORS.notParticipant);
  }

  if (ctx.role === 'photographer') {
    const clientId = project ? project.clientId : recipient;
    const hasRelationship = await ClientProfileModel.exists({
      userId: clientId,
      photographerIds: ctx.tenantId,
    });
    if (!hasRelationship && !(project && String(project.photographerId) === String(ctx.tenantId))) {
      throw ApiError.forbidden(CHAT_ERRORS.notParticipant);
    }
    return {
      photographerId: ctx.tenantId as Types.ObjectId,
      clientId,
      projectId: project?._id ?? null,
      projectKey: project ? String(project._id) : '',
    };
  }

  if (ctx.role === 'client') {
    const photographerId = project ? project.photographerId : recipient;
    // A client may only open a thread with a photographer they already belong to.
    // Otherwise the whole platform becomes an open relay to strangers.
    const hasRelationship = await ClientProfileModel.exists({
      userId: ctx.userId,
      photographerIds: photographerId,
    });
    if (!hasRelationship) throw ApiError.forbidden(CHAT_ERRORS.notParticipant);
    return {
      photographerId,
      clientId: ctx.userId,
      projectId: project?._id ?? null,
      projectKey: project ? String(project._id) : '',
    };
  }

  // Super admins have no place in client/photographer threads.
  throw ApiError.forbidden(CHAT_ERRORS.notParticipant);
}

/**
 * Write a message and update every derived field the thread list depends on.
 *
 * The unread counter is bumped for the *other* party only, so a sender never sees
 * their own message as unread.
 */
async function appendMessage(
  conversation: {
    _id: Types.ObjectId;
    photographerId: Types.ObjectId;
    clientId: Types.ObjectId;
    projectId?: Types.ObjectId | null;
    unread: { photographer: number; client: number };
    save: () => Promise<unknown>;
  },
  ctx: RequestContext,
  text: string,
) {
  const message = await MessageModel.create({
    conversationId: conversation._id,
    photographerId: conversation.photographerId,
    clientId: conversation.clientId,
    senderId: ctx.userId,
    senderRole: ctx.role,
    message: text,
  });

  const recipientId = String(ctx.userId) === String(conversation.photographerId)
    ? conversation.clientId
    : conversation.photographerId;

  const side = ctx.role === 'photographer' ? 'client' : 'photographer';
  await ConversationModel.updateOne(
    { _id: conversation._id },
    {
      $set: {
        lastMessageAt: new Date(),
        lastMessagePreview: text.slice(0, 140),
        lastMessageSenderId: ctx.userId,
      },
      $inc: { messageCount: 1, [`unread.${side}`]: 1 },
    },
  );

  const dto = toMessageDto(message.toObject(), ctx);
  emitToConversation(String(conversation._id), 'chat:message', dto);
  emitToUser(String(recipientId), 'chat:notification', {
    conversationId: String(conversation._id),
    preview: text.slice(0, 80),
    from: ctx.role === 'photographer' ? 'your photographer' : 'your client',
  });

  await notify({
    userId: recipientId,
    photographerId: conversation.photographerId,
    projectId: conversation.projectId,
    type: 'new_message',
    title: ctx.role === 'photographer' ? 'New message from your client' : 'New message from your photographer',
    message: text.slice(0, 120),
    link: `/chat/${String(conversation._id)}`,
    priority: 'normal',
  });

  return message;
}

/** Clear the caller's unread count for a thread. */
async function markRead(
  conversation: { _id: Types.ObjectId; unread: { photographer: number; client: number } },
  ctx: RequestContext,
): Promise<void> {
  const side = ctx.role === 'photographer' ? 'photographer' : 'client';

  await MessageModel.updateMany(
    { conversationId: conversation._id, senderId: { $ne: ctx.userId }, read: false },
    { $set: { read: true, readAt: new Date() } },
  );
  await ConversationModel.updateOne({ _id: conversation._id }, { $set: { [`unread.${side}`]: 0 } });
}

type ConversationShape = {
  _id: unknown;
  projectId?: unknown;
  photographerId: unknown;
  clientId: unknown;
  lastMessageAt: Date;
  lastMessagePreview: string;
  messageCount: number;
  unread: { photographer: number; client: number };
};

function participantFilter(ctx: RequestContext): Record<string, unknown> {
  return ctx.role === 'photographer' ? { photographerId: ctx.tenantId } : { clientId: ctx.userId };
}

function counterpartOf(conversation: { photographerId: unknown; clientId: unknown }, ctx: RequestContext): unknown {
  return String(ctx.userId) === String(conversation.clientId)
    ? conversation.photographerId
    : conversation.clientId;
}

function unreadFor(conversation: { unread: { photographer: number; client: number } }, ctx: RequestContext): number {
  return ctx.role === 'photographer' ? (conversation.unread?.photographer ?? 0) : (conversation.unread?.client ?? 0);
}

function toConversationDto(conversation: ConversationShape, ctx: RequestContext) {
  return {
    id: String(conversation._id),
    projectId: conversation.projectId ? String(conversation.projectId) : null,
    photographerId: String(conversation.photographerId),
    clientId: String(conversation.clientId),
    counterpartId: String(counterpartOf(conversation, ctx)),
    lastMessageAt: conversation.lastMessageAt,
    preview: conversation.lastMessagePreview,
    messageCount: conversation.messageCount,
    unread: unreadFor(conversation, ctx),
  };
}

type MessageShape = {
  _id: unknown;
  conversationId: unknown;
  senderId: unknown;
  senderRole: string;
  message: string;
  editedAt?: Date | null;
  deletedAt?: Date | null;
  createdAt: Date;
};

function toMessageDto(message: MessageShape, ctx: RequestContext) {
  return {
    id: String(message._id),
    conversationId: String(message.conversationId),
    senderId: String(message.senderId),
    senderRole: message.senderRole,
    message: message.deletedAt ? '' : message.message,
    deleted: Boolean(message.deletedAt),
    mine: String(message.senderId) === String(ctx.userId),
    editedAt: message.editedAt ?? null,
    createdAt: message.createdAt,
  };
}

async function assertParticipant(id: string, ctx: RequestContext) {
  const conversation = await ConversationModel.findById(objectId(id, 'conversation id'));
  if (!conversation) throw ApiError.notFound(CHAT_ERRORS.notFound);

  const isParticipant =
    String(conversation.photographerId) === String(ctx.tenantId) ||
    String(conversation.clientId) === String(ctx.userId);
  // A 404 rather than a 403: a non-participant should not learn that this
  // conversation id exists.
  if (!isParticipant) throw ApiError.notFound(CHAT_ERRORS.notFound);

  return conversation;
}

export default router;
