import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from '@/App';
import { AuthProvider } from '@/context/AuthContext';
// `createApiModule` / `createSocketModule` are only reachable through the
// dynamic imports inside the factories below, so they are not imported here.
import { mockRoutes, mockSession, resetState, type HarnessState } from './harness';

/**
 * End-to-end proof that the routing bugs are fixed.
 *
 * `routing.test.ts` pins the `homeFor` mapping; this file asserts the rendered
 * tree, because the original defect lived in `RequireAuth`'s redirect rather
 * than in any helper.
 *
 * A redirect loop renders as a blank frame: React Router bails out of a
 * `<Navigate>` aimed at the location it is already on and paints nothing. So
 * "the right page is on screen" is itself the assertion that the loop is gone.
 */
const state = vi.hoisted<HarnessState>(() => ({
  session: { role: 'photographer' },
  routes: {},
  urls: [],
}));

vi.mock('@/lib/api', async () => (await import('./harness')).createApiModule(() => state));
vi.mock('@/lib/socket', async () => (await import('./harness')).createSocketModule());

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

/** The harness is module-level, so each test starts from a known state. */
beforeEach(() => {
  resetState(state);
});

const adminRoutes = {
  '/admin/overview': {
    counts: {
      users: 9,
      photographers: 3,
      clients: 5,
      bookings: 5,
      pendingBookings: 1,
      projects: 5,
      photos: 24,
      inquiries: 2,
      newInquiriesThisWeek: 1,
    },
    revenue: { last30DaysMinor: 7650000, transactions: 2 },
    storage: { bytes: 524288, objects: 30 },
    generatedAt: '2026-10-01T00:00:00.000Z',
  },
  '/admin/users': {
    users: [
      {
        id: 'admin-1',
        name: 'LensFlow Admin',
        email: 'admin@lensflow.test',
        role: 'superadmin',
        status: 'active',
        emailVerified: true,
        lastLoginAt: '2026-10-01T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'user-2',
        name: 'Rae Ito',
        email: 'rae@example.test',
        role: 'photographer',
        status: 'active',
        emailVerified: true,
        lastLoginAt: '2026-09-30T00:00:00.000Z',
        createdAt: '2026-02-01T00:00:00.000Z',
      },
    ],
    pagination: { page: 1, limit: 25, total: 2, totalPages: 1 },
  },
};

describe('superadmin routing', () => {
  it('renders the admin overview instead of looping on /dashboard', async () => {
    mockSession(state, { role: 'superadmin' });
    mockRoutes(state, adminRoutes);

    renderAt('/dashboard');

    // The old guard redirected /dashboard -> /dashboard forever, leaving a
    // blank frame. Landing on the admin heading proves the redirect resolved.
    expect(await screen.findByRole('heading', { name: /platform overview/i })).toBeInTheDocument();
  });

  it('mounts /admin directly and shows platform counts from the API', async () => {
    mockSession(state, { role: 'superadmin' });
    mockRoutes(state, adminRoutes);

    renderAt('/admin');

    expect(await screen.findByRole('heading', { name: /platform overview/i })).toBeInTheDocument();
    // 9 came from GET /admin/overview, not from placeholder text.
    expect(await screen.findByText('9')).toBeInTheDocument();
    expect(screen.getByText(/3 photographers/i)).toBeInTheDocument();
    expect(state.urls).toContain('/admin/overview');
    expect(state.urls).toContain('/admin/users');
  });

  it('lists users but hides the suspend control on the admin\'s own row', async () => {
    mockSession(state, { role: 'superadmin', id: 'admin-1' });
    mockRoutes(state, adminRoutes);

    renderAt('/admin');

    expect(await screen.findByText('LensFlow Admin')).toBeInTheDocument();
    expect(screen.getByText('rae@example.test')).toBeInTheDocument();
    // PATCH /admin/users/:id/status rejects self-suspension, so the button is
    // hidden on your own row rather than left to fail.
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /suspend/i })).toHaveLength(1);
  });

  it('sends a photographer away from /admin', async () => {
    mockSession(state, { role: 'photographer' });
    mockRoutes(state, {
      '/analytics/summary': {
        projects: 0,
        bookings: { total: 0, conversion: 0, bookedMinor: 0 },
        revenue: { receivedMinor: 0, outstandingMinor: 0 },
      },
    });

    renderAt('/admin');

    expect(await screen.findByRole('heading', { name: /overview/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /platform overview/i })).not.toBeInTheDocument();
  });

  it('suspends another account with a reason, then refetches', async () => {
    mockSession(state, { role: 'superadmin', id: 'admin-1' });
    mockRoutes(state, adminRoutes);

    // The endpoint requires a reason of at least 5 characters for the audit
    // trail, so a cancel or a too-short answer must not fire the PATCH.
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('spam complaints');
    renderAt('/admin');

    const suspend = await screen.findByRole('button', { name: /suspend/i });
    suspend.click();

    await waitFor(() => {
      expect(state.urls).toContain('/admin/users/user-2/status');
    });

    // Refetched after the mutation, so the table can show the new status.
    expect(state.urls.filter((u) => u === '/admin/users').length).toBeGreaterThan(1);
    prompt.mockRestore();
  });

  it('does not call the API when the suspension reason is too short', async () => {
    mockSession(state, { role: 'superadmin', id: 'admin-1' });
    mockRoutes(state, adminRoutes);

    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('no');
    renderAt('/admin');

    const suspend = await screen.findByRole('button', { name: /suspend/i });
    suspend.click();

    await Promise.resolve();
    expect(state.urls).not.toContain('/admin/users/user-2/status');
    prompt.mockRestore();
  });
});

describe('unknown routes', () => {
  it('redirects a bogus URL home rather than rendering a blank frame', async () => {
    mockSession(state, { role: 'photographer' });

    renderAt('/this-route-does-not-exist');

    // HomePage is the marketing stub; its heading confirms the catch-all fired.
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
  });
});

describe('mock hygiene', () => {
  it('starts each test from a clean harness', async () => {
    expect(state.session).toEqual({ role: 'photographer' });
    expect(state.routes).toEqual({});
    expect(state.urls).toEqual([]);
    resetState(state);
  });
});
