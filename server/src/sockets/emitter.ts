import type { Server as IOServer } from 'socket.io';
import type { ClientToServerEvents, ServerData, ServerToClientEvents, ServerToClientPayloads } from './events.js';

/**
 * Decouples the Socket.IO server from the rest of the app.
 *
 * Services (notifications, chat) need to push real-time events but must stay
 * importable in tests, where no HTTP server is listening. `attachIo` wires the
 * real instance; until then `emitToUser` is a no-op, so nothing crashes.
 */
let io: TypedIoServer | null = null;

export type TypedIoServer = IOServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, ServerData>;

export function attachIo(server: TypedIoServer): void {
  io = server;
}

export function getIo(): TypedIoServer | null {
  return io;
}

export function isIoReady(): boolean {
  return io !== null;
}

/** Room naming: one room per user, plus one per conversation. */
export const userRoom = (userId: string) => `user:${userId}`;
export const conversationRoom = (conversationId: string) => `conversation:${conversationId}`;

/**
 * Emit on a room, with the payload type already checked by the callers below.
 *
 * Socket.IO rewrites its own `emit` parameter types through
 * `DecorateAcknowledgementsWithMultipleResponses`, which cannot be resolved for a
 * generic `K`. The event/payload pairing is enforced by `ServerToClientPayloads` on
 * the exported helpers, so the cast here only works around that internal rewrite.
 */
function rawEmit<K extends keyof ServerToClientPayloads>(
  target: unknown,
  event: K,
  payload: ServerToClientPayloads[K],
): void {
  (target as { emit: (event: string, payload: unknown) => void }).emit(event, payload);
}

/**
 * Emit to a single user's room.
 *
 * The generic signature ties `payload` to `event`, so `emitToUser(id, 'typing:start', …)`
 * with the wrong payload shape is a compile error rather than a runtime no-op.
 */
export function emitToUser<K extends keyof ServerToClientPayloads>(
  userId: string,
  event: K,
  payload: ServerToClientPayloads[K],
): void {
  if (!io) return;
  rawEmit(io.to(userRoom(userId)), event, payload);
}

export function emitToUsers<K extends keyof ServerToClientPayloads>(
  userIds: string[],
  event: K,
  payload: ServerToClientPayloads[K],
): void {
  if (!io) return;
  for (const userId of userIds) rawEmit(io.to(userRoom(userId)), event, payload);
}

export function emitToConversation<K extends keyof ServerToClientPayloads>(
  conversationId: string,
  event: K,
  payload: ServerToClientPayloads[K],
  exceptSocketId?: string,
): void {
  if (!io) return;
  const room = io.to(conversationRoom(conversationId));
  rawEmit(exceptSocketId ? room.except(exceptSocketId) : room, event, payload);
}

export function onlineUserIds(): string[] {
  if (!io) return [];
  const ids = new Set<string>();
  for (const [, socket] of io.sockets.sockets) {
    const userId = (socket.data as { userId?: string }).userId;
    if (userId) ids.add(userId);
  }
  return [...ids];
}
