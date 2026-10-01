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
}

export function defaultState(): HarnessState {
  return { session: { role: 'photographer' }, routes: {}, urls: [] };
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

      if (url.includes('/auth/me')) return sessionPayload(state.session);

      const key = Object.keys(state.routes).find((pattern) => url.includes(pattern));
      return key ? state.routes[key] : {};
    }),
    errorMessage: (error: unknown, fallback = 'Something went wrong.') =>
      (error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback,
    errorCode: () => undefined,
    setAccessToken: () => {},
    getAccessToken: () => null,
    api: { interceptors: { request: { use: () => {} }, response: { use: () => {} } } },
  };
}

export function createSocketModule() {
  return { connectSocket: () => {}, disconnectSocket: () => {} };
}
