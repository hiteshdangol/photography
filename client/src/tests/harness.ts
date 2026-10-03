import { vi } from 'vitest';

export interface MockSession {
  role: 'superadmin' | 'photographer' | 'client';
  name?: string;
  email?: string;
  id?: string;
}

/** Responses keyed by URL substring; the first match wins. */
export type RouteResponses = Record<string, unknown>;

export interface HarnessState {
  session: MockSession;
  routes: RouteResponses;
  /** Every URL passed to `request`, so a test can assert which endpoint ran. */
  urls: string[];
  /**
   * Every request with its params and method.
   *
   * `urls` alone cannot distinguish "asked the server for editing" from
   * "filtered the full response locally" - both hit `/projects`. Anything
   * asserting that a filter or page reached the API has to read this.
   */
  calls: { url: string; method: string; params: Record<string, unknown> }[];
  /**
   * URL substring -> error message. A matching request rejects instead of
   * resolving, so the error paths (expired links, 404s) can be exercised.
   * Without this, every endpoint resolves and error handling is untested.
   */
  failures?: Record<string, string>;
}

export function defaultState(): HarnessState {
  return { session: { role: 'photographer' }, routes: {}, urls: [], calls: [], failures: {} };
}

/** Marks a route as failing with `message`, mirroring an axios rejection. */
export function mockFailures(state: HarnessState, next: Record<string, string>): void {
  state.failures = next;
}

export function mockSession(state: HarnessState, next: MockSession): void {
  state.session = next;
}

export function mockRoutes(state: HarnessState, next: RouteResponses): void {
  state.routes = next;
}

export function resetState(state: HarnessState): void {
  state.session = { role: 'photographer' };
  state.routes = {};
  state.urls.length = 0;
  state.calls.length = 0;
  state.failures = {};
}

/** `GET /auth/me` payload, so `AuthProvider` resolves to an authenticated session. */
function sessionPayload(session: MockSession) {
  return {
    user: {
      id: session.id ?? 'user-1',
      name: session.name ?? 'Test User',
      email: session.email ?? 'test@example.test',
      role: session.role,
      status: 'active',
      emailVerified: true,
    },
  };
}

/**
 * Builds the replacement for `@/lib/api`.
 *
 * `getState` is a getter rather than the object itself: the mock factory runs
 * while `@/lib/api` is being imported, which happens *before* the test file's
 * `vi.hoisted` assignment, so reading the state eagerly saw `undefined` and
 * every request threw. Deferring the read to call time avoids that.
 */
export function createApiModule(getState: () => HarnessState) {
  return {
    // `request<T>` resolves to the payload itself (it strips the
    // `{ success, message, data }` envelope), so the mock resolves to the bare
    // payload. Returning `{ data: payload }` here makes callers destructure
    // `undefined` and looks like an auth failure.
    request: vi.fn(async (config: { url?: string; method?: string; params?: unknown }) => {
      const state = getState();
      const url = String(config?.url ?? '');
      state.urls.push(url);
      state.calls.push({
        url,
        method: String(config?.method ?? 'get').toLowerCase(),
        params: (config?.params ?? {}) as Record<string, unknown>,
      });

      // Checked before the `/auth/me` shortcut, so a test can make the app
      // anonymous by failing that one endpoint - which is how a share-link
      // recipient actually arrives.
      const failures = state.failures ?? {};
      const failure = Object.keys(failures).find((pattern) => url.includes(pattern));
      if (failure) {
        // Shaped like an axios error so `errorMessage` can read it, which is
        // what the pages actually render.
        throw {
          isAxiosError: true,
          message: failures[failure],
          response: { status: 403, data: { success: false, message: failures[failure] } },
        };
      }

      if (url.includes('/auth/me')) return sessionPayload(state.session);

      const key = Object.keys(state.routes).find((pattern) => url.includes(pattern));
      return key ? state.routes[key] : {};
    }),
    errorMessage: (error: unknown, fallback = 'Something went wrong.') =>
      (error as { isAxiosError?: boolean; response?: { data?: { message?: string } } })?.response?.data
        ?.message ?? fallback,
    errorCode: () => undefined,
    setAccessToken: () => {},
    getAccessToken: () => null,
    api: { interceptors: { request: { use: () => {} }, response: { use: () => {} } } },
  };
}

/**
 * Builds the replacement for `@/lib/socket`.
 *
 * `getSocket` is included because components reach for the shared singleton
 * rather than the `connectSocket` helper: ChatPage subscribes to realtime events
 * on mount, so a stub without it would throw on `getSocket().connect()` and
 * fail the test for a reason that has nothing to do with the assertion.
 */
export function createSocketModule() {
  const socket = {
    connected: false,
    connect: vi.fn(() => {
      socket.connected = true;
    }),
    disconnect: vi.fn(() => {
      socket.connected = false;
    }),
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    once: vi.fn(),
  };

  return {
    connectSocket: vi.fn(),
    disconnectSocket: vi.fn(),
    getSocket: () => socket,
  };
}