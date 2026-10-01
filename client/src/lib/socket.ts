import { io, type Socket } from 'socket.io-client';
import { getAccessToken } from './api';

/**
 * One lazily-created socket for the whole app.
 *
 * The access token is read at connect time (not import time) because it is
 * refreshed on boot; reconnecting after a refresh picks up the new token.
 */
let socket: Socket | null = null;

export function getSocket(): Socket {
  if (socket) return socket;
  socket = io({
    path: '/socket.io',
    withCredentials: true,
    autoConnect: false,
    auth: (cb) => cb({ token: getAccessToken() ?? '' }),
  });
  return socket;
}

export function connectSocket(): Socket {
  const s = getSocket();
  if (!s.connected) s.connect();
  return s;
}

export function disconnectSocket(): void {
  if (socket?.connected) socket.disconnect();
}
