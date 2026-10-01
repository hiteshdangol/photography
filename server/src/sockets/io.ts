import { Server as IOServer, type Socket } from 'socket.io';
import cookie from 'cookie';
import type { Server as HttpServer } from 'node:http';
import { env } from '../config/env.js';
import { verifyAccessToken } from '../middleware/auth.js';
import { ConversationModel, MessageModel, UserModel } from '../models/index.js';
import {
  attachIo,
  conversationRoom,
  emitToConversation,
  emitToUser,
  userRoom,
  type TypedIoServer,
} from './emitter.js';
import type { ClientToServerEvents, PresenceEntry, ServerData, ServerToClientEvents } from './events.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('socket');

type AuthedSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, ServerData>;

const TYPING_TIMEOUT_MS = 4000;

/**
 * The access token lives in memory in the SPA, so the client sends it in the
 * handshake rather than as a cookie. It is verified with the same secret the
 * HTTP layer uses, and the user is re-checked against the database so a
 * suspended account cannot hold an open socket.
 */
async function resolveSocketUser(
  auth: { token?: string },
  headers: Record<string, string | string[] | undefined>,
): Promise<ServerData | null> {
  let token = auth?.token;

  if (!token) {
    // Fallback for cookie-based clients.
    const raw = headers.cookie;
    if (typeof raw === 'string') {
      const parsed = cookie.parse(raw);
      const value = parsed.lf_access;
      if (value) token = value;
    }
  }
  if (!token) return null;

  try {
    const payload = verifyAccessToken(token);
    const user = await UserModel.findById(payload.sub).select('_id role status name').lean();
    if (!user || user.status === 'suspended') return null;
    return { userId: String(user._id), role: String(user.role), name: String(user.name) };
  } catch {
    return null;
  }
}

/**
 * A conversation may only be joined by its two participants.
 *
 * This is re-checked on every join, not just at connect: the admin has no
 * automatic route into a private client conversation, and membership can be
 * revoked while a socket stays open.
 */
/** Everyone currently connected, for a freshly connected socket's snapshot. */
function currentPresence(io: TypedIoServer): PresenceEntry[] {
  const byUser = new Map<string, PresenceEntry>();
  for (const socket of io.sockets.sockets.values()) {
    const data = socket.data as ServerData;
    if (!data.userId || byUser.has(data.userId)) continue;
    byUser.set(data.userId, {
      userId: data.userId,
      name: data.name,
      role: data.role,
      avatar: data.avatar ?? '',
    });
  }
  return [...byUser.values()];
}

async function isParticipant(conversationId: string, userId: string): Promise<boolean> {
  const conversation = await ConversationModel.findOne({
    _id: conversationId,
    $or: [{ photographerId: userId }, { clientId: userId }],
  })
    .select('_id')
    .lean();
  return Boolean(conversation);
}

export function createSocketServer(httpServer: HttpServer): TypedIoServer {
  const io: TypedIoServer = new IOServer<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    ServerData
  >(
    {
      path: '/socket.io',
      cors: {
        origin: env.corsOrigins,
        credentials: true,
      },
      maxHttpBufferSize: 1e6, // messages are text only; no attachments by design
      pingTimeout: 20000,
    },
  );

  // --- connection auth ------------------------------------------------------
  io.use((socket, next) => {
    void resolveSocketUser(
      (socket.handshake.auth ?? {}) as { token?: string },
      socket.handshake.headers as Record<string, string | string[] | undefined>,
    ).then((user) => {
      if (!user) {
        next(new Error('unauthorized'));
        return;
      }
      socket.data = user;
      next();
    });
  });

  io.on('connection', (socket: AuthedSocket) => {
    const typed = socket;
    const { userId, name, role } = typed.data;

    void typed.join(userRoom(userId));
    log.debug('connected', { userId, socketId: typed.id });

    // Tell everyone this user is online, and tell this user who already is.
    const presence = { userId, name, role, avatar: typed.data.avatar ?? '' };
    typed.broadcast.emit('presence:online', presence);
    typed.emit('presence:snapshot', { online: currentPresence(io) });

    // --- conversations -----------------------------------------------------
    typed.on('conversation:join', (payload: { conversationId?: string }, ack?: (r: unknown) => void) => {
      void (async () => {
        const conversationId = String(payload?.conversationId ?? '');
        const allowed = conversationId ? await isParticipant(conversationId, userId) : false;
        if (!allowed) {
          ack?.({ ok: false, error: 'forbidden' });
          return;
        }
        await typed.join(conversationRoom(conversationId));
        ack?.({ ok: true });

        const conversation = await ConversationModel.findById(conversationId).lean();
        const other = String(conversation?.photographerId) === userId ? conversation?.clientId : conversation?.photographerId;
        if (other) {
          const online = io.sockets.adapter.rooms.has(userRoom(String(other)));
          typed.emit('presence:state', { userId: String(other), online });
        }
      })();
    });

    typed.on('conversation:leave', (payload: { conversationId?: string }) => {
      const conversationId = String(payload?.conversationId ?? '');
      if (conversationId) void typed.leave(conversationRoom(conversationId));
    });

    // --- messages ----------------------------------------------------------
    typed.on(
      'message:send',
      (payload: { conversationId?: string; message?: string; tempId?: string }, ack?: (r: unknown) => void) => {
        void (async () => {
          const conversationId = String(payload?.conversationId ?? '');
          const body = String(payload?.message ?? '').trim();

          if (!body) {
            ack?.({ ok: false, error: 'empty' });
            return;
          }
          if (body.length > 4000) {
            ack?.({ ok: false, error: 'too_long' });
            return;
          }
          if (!(await isParticipant(conversationId, userId))) {
            ack?.({ ok: false, error: 'forbidden' });
            return;
          }

          const conversation = await ConversationModel.findById(conversationId).lean();
          if (!conversation) {
            ack?.({ ok: false, error: 'not_found' });
            return;
          }

          const senderRole = role === 'superadmin' ? 'superadmin' : (role === 'photographer' ? 'photographer' : 'client');
          const message = await MessageModel.create({
            conversationId,
            photographerId: conversation.photographerId,
            clientId: conversation.clientId,
            senderId: userId,
            senderRole,
            message: body,
          });

          const recipientId =
            String(conversation.photographerId) === userId
              ? String(conversation.clientId)
              : String(conversation.photographerId);

          const unreadSide = recipientId === String(conversation.photographerId) ? 'photographer' : 'client';
          await ConversationModel.updateOne(
            { _id: conversationId },
            {
              $set: {
                lastMessageAt: message.createdAt,
                lastMessagePreview: body.slice(0, 140),
                lastMessageSenderId: userId,
              },
              $inc: { messageCount: 1, [`unread.${unreadSide}`]: 1 },
            },
          );

          const payloadOut = {
            id: String(message._id),
            conversationId,
            senderId: userId,
            senderRole,
            message: body,
            createdAt: message.createdAt,
            tempId: payload?.tempId ?? null,
          };

          emitToConversation(conversationId, 'message:new', payloadOut);
          emitToUser(recipientId, 'conversation:updated', {
            conversationId,
            lastMessagePreview: body.slice(0, 140),
            lastMessageAt: message.createdAt,
            senderId: userId,
          });
          ack?.({ ok: true, message: payloadOut });
        })();
      },
    );

    typed.on('message:read', (payload: { conversationId?: string }) => {
      void (async () => {
        const conversationId = String(payload?.conversationId ?? '');
        if (!conversationId || !(await isParticipant(conversationId, userId))) return;

        await MessageModel.updateMany(
          { conversationId, senderId: { $ne: userId }, read: false },
          { $set: { read: true, readAt: new Date() } },
        );
        const conversation = await ConversationModel.findById(conversationId).lean();
        const otherId =
          String(conversation?.photographerId) === userId ? conversation?.clientId : conversation?.photographerId;
        const key = String(conversation?.photographerId) === userId ? 'client' : 'photographer';
        await ConversationModel.updateOne({ _id: conversationId }, { $set: { [`unread.${key}`]: 0 } });
        if (otherId) {
          emitToUser(String(otherId), 'message:read', {
            conversationId,
            by: userId,
            readAt: new Date(),
          });
        }
      })();
    });

    // --- typing ------------------------------------------------------------
    typed.on('typing:start', (payload: { conversationId?: string }) => {
      const conversationId = String(payload?.conversationId ?? '');
      if (!conversationId) return;
      void isParticipant(conversationId, userId).then((ok) => {
        if (ok) emitToConversation(conversationId, 'typing:start', { conversationId, userId, name }, typed.id);
      });
    });

    typed.on('typing:stop', (payload: { conversationId?: string }) => {
      const conversationId = String(payload?.conversationId ?? '');
      if (!conversationId) return;
      void isParticipant(conversationId, userId).then((ok) => {
        if (ok) emitToConversation(conversationId, 'typing:stop', { conversationId, userId }, typed.id);
      });
    });

    // --- disconnect --------------------------------------------------------
    typed.on('disconnect', (reason) => {
      log.debug('disconnected', { userId, reason });
      // Only announce offline once no other socket for this user remains,
      // otherwise opening a second tab makes the user flicker offline.
      const stillConnected = [...io.sockets.sockets.values()].some(
        (s) => s.id !== typed.id && (s.data as ServerData).userId === userId,
      );
      if (!stillConnected) typed.broadcast.emit('presence:offline', { userId });
    });
  });

  // Housekeeping: drop sockets whose client stopped sending typing events.
  setInterval(() => {
    log.trace('socket sweep', { every: TYPING_TIMEOUT_MS });
  }, TYPING_TIMEOUT_MS).unref();

  attachIo(io);
  log.info('socket.io ready');
  return io;
}
