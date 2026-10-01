/**
 * Socket.IO event contracts, shared by the server and the typed emitter helpers.
 *
 * Socket.IO is typed through explicit event maps. Anything not declared here
 * resolves to `never`, which makes the corresponding `emit`/`on` a compile error -
 * that is deliberate: it stops a typo'd event name from silently never firing.
 *
 * Payloads are declared as a plain event -> payload map rather than as function
 * types. Recent Socket.IO versions rewrite the function form internally to inject
 * an acknowledgement parameter, which makes `Parameters<Fn>[0]` stop matching the
 * real payload; the map form stays stable.
 */

export interface ServerData {
  userId: string;
  role: string;
  name: string;
  avatar?: string;
}

export interface PresenceEntry {
  userId: string;
  name: string;
  role: string;
  avatar: string;
}

export interface MessagePayload {
  id: string;
  conversationId: string;
  senderId: string;
  senderRole: string;
  message: string;
  createdAt: Date;
  tempId?: string | null;
}

/** Every event the server can send to a client, and the payload it carries. */
export interface ServerToClientPayloads {
  'presence:online': PresenceEntry;
  'presence:offline': { userId: string };
  'presence:snapshot': { online: PresenceEntry[] };
  'presence:state': { userId: string; online: boolean };
  'conversation:joined': { conversationId: string; other: unknown };
  'conversation:updated': {
    conversationId: string;
    lastMessagePreview: string;
    lastMessageAt: Date;
    senderId: string;
  };
  'message:new': MessagePayload;
  'message:read': { conversationId: string; by: string; readAt: Date };
  'message:deleted': { conversationId: string; messageId: string; deletedAt: Date };
  'typing:start': { conversationId: string; userId: string; name: string };
  'typing:stop': { conversationId: string; userId: string };
  'notification:new': {
    id: string;
    type: string;
    title: string;
    message: string;
    link: string;
    createdAt: Date;
  };
  'notification:removed': { id: string };
  'chat:message': {
    id: string;
    conversationId: string;
    senderId: string;
    senderRole: string;
    message: string;
    deleted: boolean;
    mine: boolean;
    editedAt: Date | null;
    createdAt: Date;
  };
  'chat:updated': { id: string; message: string; editedAt: Date | null };
  'chat:deleted': { id: string };
  'chat:notification': { conversationId: string; preview: string; from: string };
  'error:message': { code: string; message: string };
}

export interface ClientToServerPayloads {
  'conversation:join': { conversationId?: string };
  'conversation:leave': { conversationId?: string };
  'message:send': { conversationId?: string; message?: string; tempId?: string };
  'message:read': { conversationId?: string };
  'message:delete': { messageId?: string };
  'typing:start': { conversationId?: string };
  'typing:stop': { conversationId?: string };
  'ping:check': Record<string, never>;
}

/** Socket.IO's client -> server event map, with optional acknowledgements. */
export interface ClientToServerEvents {
  'conversation:join': (
    payload: ClientToServerPayloads['conversation:join'],
    ack?: (response: unknown) => void,
  ) => void;
  'conversation:leave': (payload: ClientToServerPayloads['conversation:leave']) => void;
  'message:send': (
    payload: ClientToServerPayloads['message:send'],
    ack?: (response: unknown) => void,
  ) => void;
  'message:read': (payload: ClientToServerPayloads['message:read']) => void;
  'message:delete': (
    payload: ClientToServerPayloads['message:delete'],
    ack?: (response: unknown) => void,
  ) => void;
  'typing:start': (payload: ClientToServerPayloads['typing:start']) => void;
  'typing:stop': (payload: ClientToServerPayloads['typing:stop']) => void;
  'ping:check': (payload: ClientToServerPayloads['ping:check'], ack?: (response: unknown) => void) => void;
}

/** Socket.IO's server -> client event map, derived from the payload map. */
export type ServerToClientEvents = {
  [K in keyof ServerToClientPayloads]: (payload: ServerToClientPayloads[K]) => void;
};

/** Every event name the server can emit to a client. */
export type ServerEvent = keyof ServerToClientPayloads;

/** Every event name a client can send to the server. */
export type ClientEvent = keyof ClientToServerPayloads;
