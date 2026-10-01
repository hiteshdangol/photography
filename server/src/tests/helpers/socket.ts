import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

export interface SocketClientOptions {
  url: string;
  token?: string;
}

/**
 * Drives a real Socket.IO client against the in-process server so the handshake
 * travels over HTTP. Mocking this would miss the regression that matters here:
 * an `IOServer` constructed without its HTTP server never handles the upgrade,
 * and every handshake falls through to the Express 404 handler.
 */
function build(options: SocketClientOptions): ClientSocket {
  return ioClient(options.url, {
    path: '/socket.io',
    transports: ['websocket'],
    auth: options.token ? { token: options.token } : {},
    reconnection: false,
    forceNew: true,
  });
}

export function connectSocket(options: SocketClientOptions): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = build(options);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (error) => {
      socket.close();
      reject(error);
    });
  });
}

/** Resolves with the connection error, so a test can assert *why* it failed. */
export function connectSocketExpectingError(options: SocketClientOptions): Promise<Error> {
  return new Promise((resolve, reject) => {
    const socket = build(options);
    socket.once('connect', () => {
      socket.close();
      reject(new Error('socket connected but the handshake was expected to be rejected'));
    });
    socket.once('connect_error', (error) => {
      socket.close();
      resolve(error);
    });
  });
}

/** Emits an event and resolves with the server's acknowledgement payload. */
export function emitWithAck<T = unknown>(
  socket: ClientSocket,
  event: string,
  payload: unknown,
  timeoutMs = 10_000,
): Promise<{ ok: boolean; data?: T; error?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ack timeout for "${event}"`)), timeoutMs);
    socket.emit(event, payload, (response: { ok: boolean; data?: T; error?: string }) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

/** Waits for one server->client event, rejecting rather than hanging on timeout. */
export function once<T = unknown>(socket: ClientSocket, event: string, timeoutMs = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}
