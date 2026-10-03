import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from '@/App';
import { AuthProvider } from '@/context/AuthContext';
import { mockFailures, mockRoutes, mockSession, resetState, type HarnessState } from './harness';

/**
 * The photographer dashboard and the client's own space.
 *
 * Every page here replaced a `SectionPlaceholder` that rendered a heading and
 * nothing else, so the assertions are mostly about *data reaching the screen*:
 * these routes already existed and looked like they worked.
 */
const state = vi.hoisted<HarnessState>(() => ({
  session: { role: 'photographer' as const },
  routes: {},
  urls: [],
  calls: [],
}));

vi.mock('@/lib/api', async () => (await import('./harness')).createApiModule(() => state));
vi.mock('@/lib/socket', async () => (await import('./harness')).createSocketModule());

beforeEach(() => {
  resetState(state);
});

function project(id: string, overrides: Record<string, unknown> = {}) {
  return {
    _id: id,
    title: `Project ${id}`,
    slug: `project-${id}`,
    eventDate: '2026-05-02T00:00:00.000Z',
    location: 'Pokhara',
    eventType: 'Wedding',
    coverPhotoId: null,
    status: 'editing',
    timelineStage: 'editing',
    timelineCompletedAt: null,
    gallery: {
      published: false,
      publishedAt: null,
      highlightsPublishedAt: null,
      highlightsCount: 0,
      totalPhotos: 0,
      allowClientDownloads: true,
      allowOriginalDownloads: false,
      deliveredAt: null,
      expiresAt: null,
    },
    counts: { photos: 0, highlights: 0, albums: 0, selections: 0, favorites: 0 },
    totalMinor: 120_000,
    currency: 'NPR',
    clientId: { _id: 'user-1', name: 'Mia Rai', email: 'mia@example.test' },
    ...overrides,
  };
}

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

const emptyPagination = { page: 1, limit: 24, total: 0, totalPages: 1 };

describe('photographer projects', () => {
  it('lists projects and links each to its project page', async () => {
    mockRoutes(state, {
      '/projects/summary': {
        totals: { total: 3, valueMinor: 300_000, active: 1, delivered: 2 },
        byStage: {},
        upcoming: [],
        needsAttention: 1,
      },
      '/projects': {
        projects: [project('p1'), project('p2')],
        pagination: { ...emptyPagination, total: 2, totalPages: 1 },
        summary: [],
      },
    });

    renderAt('/dashboard/projects');

    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Project p1' })).toHaveAttribute(
      'href',
      '/dashboard/projects/p1',
    );
  });

  it('surfaces projects past their event date that were never delivered', async () => {
    // This is the number that makes the screen useful: work that quietly went
    // stale. If the summary request silently failed to render, a photographer
    // would never learn a shoot is overdue.
    mockRoutes(state, {
      '/projects/summary': {
        totals: { total: 1, valueMinor: 0, active: 1, delivered: 0 },
        byStage: {},
        upcoming: [],
        needsAttention: 4,
      },
      '/projects': { projects: [], pagination: emptyPagination, summary: [] },
    });

    renderAt('/dashboard/projects');

    expect(await screen.findByText('Needs attention')).toBeInTheDocument();
    expect(await screen.findByText('4')).toBeInTheDocument();
  });

  it('filters by status and refetches rather than filtering locally', async () => {
    mockRoutes(state, {
      '/projects/summary': {
        totals: { total: 0, valueMinor: 0, active: 0, delivered: 0 },
        byStage: {},
        upcoming: [],
        needsAttention: 0,
      },
      '/projects': { projects: [], pagination: emptyPagination, summary: [] },
    });

    renderAt('/dashboard/projects');
    await screen.findByRole('heading', { name: 'Projects' });

    await userEvent.click(screen.getByRole('tab', { name: 'Editing' }));

    /* Asserting the endpoint ran again would pass even if the page filtered the
     * received array itself, so this checks the status actually left the
     * browser as a query param. */
    await waitFor(() => {
      const call = state.calls.filter((entry) => entry.url === '/projects').at(-1);
      expect(call?.params).toMatchObject({ status: 'editing', page: 1 });
    });
  });

  it('shows an error state when the list cannot be loaded', async () => {
    mockRoutes(state, {
      '/projects/summary': {
        totals: { total: 0, valueMinor: 0, active: 0, delivered: 0 },
        byStage: {},
        upcoming: [],
        needsAttention: 0,
      },
      '/projects': { projects: [], pagination: emptyPagination, summary: [] },
    });
    mockFailures(state, { '/projects': 'server exploded' });

    renderAt('/dashboard/projects');

    expect(
      await screen.findByText('We could not load your projects.', undefined, { timeout: 4000 }),
    ).toBeInTheDocument();
  });
});

describe('client galleries', () => {
  it('separates published galleries from ones still being edited', async () => {
    mockSession(state, { role: 'client', name: 'Mia' });
    mockRoutes(state, {
      '/projects': {
        projects: [
          project('live', {
            title: 'Autumn Wedding',
            gallery: { published: true, publishedAt: '2026-05-10T00:00:00.000Z', expiresAt: '2027-05-10T00:00:00.000Z' },
            counts: { photos: 120, highlights: 12, albums: 4, selections: 0, favorites: 3 },
          }),
          project('draft', { title: 'Family Portraits' }),
        ],
        pagination: emptyPagination,
        summary: [],
      },
    });

    renderAt('/me/galleries');

    expect(await screen.findByRole('heading', { name: 'Your galleries' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Open gallery' })).toHaveAttribute('href', '/projects/live');
    /* The unpublished project must not offer an entry point, only a status. */
    expect(screen.queryAllByRole('link', { name: 'Open gallery' })).toHaveLength(1);
    expect(await screen.findByText('Family Portraits')).toBeInTheDocument();
  });
});

describe('invoices and billing', () => {
  const invoices = {
    invoices: [
      {
        id: 'i1',
        invoiceNumber: 'INV-001',
        bookingId: 'b1',
        projectId: 'p1',
        subtotalMinor: 100_000,
        discountMinor: 0,
        taxMinor: 0,
        totalMinor: 100_000,
        paidMinor: 0,
        remainingMinor: 100_000,
        currency: 'NPR',
        status: 'unpaid',
        dueDate: '2026-01-01T00:00:00.000Z',
        paidAt: null,
        balanceDueMinor: 100_000,
        hasPdf: true,
        pdfUrl: '/api/invoices/i1/pdf',
        /* Server-derived, and deliberately past due despite `unpaid`. */
        overdue: true,
        viewerRole: 'photographer',
        editable: true,
        createdAt: '2025-12-01T00:00:00.000Z',
      },
    ],
    summary: { totalMinor: 100_000, paidMinor: 0, outstandingMinor: 100_000 },
    pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
  };

  it('shows the photographer ledger with outstanding totals', async () => {
    mockRoutes(state, { '/invoices': invoices });

    renderAt('/dashboard/invoices');

    expect(await screen.findByRole('heading', { name: 'Invoices' })).toBeInTheDocument();
    expect(await screen.findByText('INV-001')).toBeInTheDocument();
    /* Queried by role: "Outstanding" is both a stat-card label and a column
     * header, so a bare text query is ambiguous. */
    expect(await screen.findByRole('columnheader', { name: 'Outstanding' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Status' })).toBeInTheDocument();
  });

  it('leads with what a client still owes', async () => {
    mockSession(state, { role: 'client', name: 'Mia' });
    mockRoutes(state, { '/invoices': invoices });

    renderAt('/me/billing');

    expect(await screen.findByRole('heading', { name: 'Billing' })).toBeInTheDocument();
    /* An overdue unpaid invoice belongs under "Awaiting payment", not "Paid". */
    expect(await screen.findByText('Awaiting payment')).toBeInTheDocument();
    expect(await screen.findByText('overdue')).toBeInTheDocument();
  });
});

describe('analytics', () => {
  it('renders revenue and engagement for the selected window', async () => {
    mockRoutes(state, {
      '/analytics/summary': {
        range: { from: null, to: '2026-05-01T00:00:00.000Z', days: 30 },
        bookings: { total: 8, byStatus: {}, bookedMinor: 500_000, conversion: 62.5 },
        revenue: { receivedMinor: 300_000, transactions: 6, byCurrency: [], outstandingMinor: 0, outstandingInvoices: 0 },
        projects: 5,
        clients: 4,
      },
      '/analytics/revenue': {
        range: { from: null, to: '2026-05-01T00:00:00.000Z' },
        groupBy: 'month',
        series: [
          { period: '2026-03', minor: 100_000, transactions: 2, feesMinor: 0 },
          { period: '2026-04', minor: 200_000, transactions: 4, feesMinor: 0 },
        ],
        totalMinor: 300_000,
        averageTransactionMinor: 50_000,
      },
      '/analytics/engagement': {
        range: { from: null, to: '2026-05-01T00:00:00.000Z' },
        photosUploaded: 40,
        selectionsMade: 12,
        favoritesGiven: 30,
        albums: 5,
        publishedGalleries: 3,
        projects: [],
        averages: { selectionsPerProject: 1.2, favoritesPerPhoto: 0.75 },
      },
      '/analytics/testimonials': {
        average: 4.5,
        total: 2,
        approved: 2,
        awaitingReview: 0,
        distribution: [
          { star: 5, count: 1 },
          { star: 4, count: 1 },
          { star: 3, count: 0 },
          { star: 2, count: 0 },
          { star: 1, count: 0 },
        ],
        recent: [],
      },
    });

    renderAt('/dashboard/analytics');

    expect(await screen.findByRole('heading', { name: 'Analytics' })).toBeInTheDocument();
    expect(await screen.findByText('Revenue received')).toBeInTheDocument();
    expect(await screen.findByText('Gallery engagement')).toBeInTheDocument();
    /* Series are rendered as titled bars, which proves the data reached a bar. */
    await waitFor(() => {
      const bars = document.querySelectorAll('[title*="2026-03"]');
      expect(bars.length).toBeGreaterThan(0);
    });
  });

  it('refetches every panel when the window changes', async () => {
    mockRoutes(state, {
      '/analytics/summary': {
        range: { from: null, to: '2026-05-01T00:00:00.000Z', days: 30 },
        bookings: { total: 0, byStatus: {}, bookedMinor: 0, conversion: 0 },
        revenue: { receivedMinor: 0, transactions: 0, byCurrency: [], outstandingMinor: 0, outstandingInvoices: 0 },
        projects: 0,
        clients: 0,
      },
      '/analytics/revenue': {
        range: { from: null, to: '2026-05-01T00:00:00.000Z' },
        groupBy: 'month',
        series: [],
        totalMinor: 0,
        averageTransactionMinor: 0,
      },
      '/analytics/engagement': {
        range: { from: null, to: '2026-05-01T00:00:00.000Z' },
        photosUploaded: 0,
        selectionsMade: 0,
        favoritesGiven: 0,
        albums: 0,
        publishedGalleries: 0,
        projects: [],
        averages: { selectionsPerProject: 0, favoritesPerPhoto: 0 },
      },
      '/analytics/testimonials': {
        average: 0,
        total: 0,
        approved: 0,
        awaitingReview: 0,
        distribution: [],
        recent: [],
      },
    });

    renderAt('/dashboard/analytics');
    await screen.findByRole('heading', { name: 'Analytics' });
    await waitFor(() => expect(state.urls).toContain('/analytics/summary'));

    const before = state.urls.filter((url) => url === '/analytics/summary').length;
    await userEvent.click(screen.getByRole('tab', { name: '7 days' }));
    await waitFor(() =>
      expect(state.urls.filter((url) => url === '/analytics/summary').length).toBeGreaterThan(before),
    );
  });
});

describe('clients', () => {
  const clients = {
    clients: [
      {
        clientId: 'c1',
        name: 'Mia Rai',
        email: 'mia@example.test',
        phone: '',
        avatar: '',
        bookings: 3,
        cancelled: 0,
        spentMinor: 300_000,
        lastBookingAt: '2026-04-01T00:00:00.000Z',
        repeat: true,
      },
      {
        clientId: 'c2',
        name: 'Sita Gurung',
        email: 'sita@example.test',
        phone: '',
        avatar: '',
        bookings: 1,
        cancelled: 0,
        spentMinor: 50_000,
        lastBookingAt: '2026-01-01T00:00:00.000Z',
        repeat: false,
      },
    ],
    range: { from: null, to: '2026-05-01T00:00:00.000Z' },
  };

  it('lists clients with their spend and repeat status', async () => {
    mockRoutes(state, { '/analytics/clients': clients });

    renderAt('/dashboard/clients');

    expect(await screen.findByRole('heading', { name: 'Clients' })).toBeInTheDocument();
    expect(await screen.findByText('Mia Rai')).toBeInTheDocument();
    expect(await screen.findByText('Sita Gurung')).toBeInTheDocument();
    expect(screen.getAllByText('repeat')).toHaveLength(1);
  });

  it('narrows to repeat clients on request', async () => {
    mockRoutes(state, { '/analytics/clients': clients });

    renderAt('/dashboard/clients');
    await screen.findByText('Mia Rai');

    await userEvent.click(screen.getByRole('checkbox', { name: /repeat clients only/i }));

    await waitFor(() => expect(screen.queryByText('Sita Gurung')).not.toBeInTheDocument());
    expect(screen.getByText('Mia Rai')).toBeInTheDocument();
  });
});

describe('bookings show both parties and the package', () => {
  const booking = (overrides: Record<string, unknown> = {}) => ({
    _id: 'b1',
    reference: 'LF-BK-8FK2QW',
    eventType: 'Wedding',
    eventDate: '2026-05-02T00:00:00.000Z',
    startTime: '09:00',
    endTime: '16:00',
    location: 'Pokhara',
    status: 'approved',
    paymentStatus: 'deposit_paid',
    clientId: { _id: 'c1', name: 'Mia Rai' },
    photographerId: { _id: 'p1', name: 'Aarav Shrestha' },
    priceSnapshot: { packageName: 'Signature Wedding', totalMinor: 250_000, depositMinor: 50_000 },
    ...overrides,
  });

  it('shows a client the photographer they booked', async () => {
    /* Regression: the server populated only `clientId`, so `photographerId` came
     * back as a bare ObjectId and the page fell back to the internal booking
     * reference. The client's own photographer's name was invisible. */
    mockSession(state, { role: 'client', name: 'Mia' });
    mockRoutes(state, { '/bookings': { bookings: [booking()] } });

    renderAt('/me/bookings');

    expect(await screen.findByRole('heading', { name: 'My bookings' })).toBeInTheDocument();
    expect(await screen.findByText('Aarav Shrestha')).toBeInTheDocument();
  });

  it('shows the client their package name', async () => {
    mockSession(state, { role: 'client', name: 'Mia' });
    mockRoutes(state, { '/bookings': { bookings: [booking()] } });

    renderAt('/me/bookings');

    /* The package is what the client asked for, so it leads the row. */
    expect(await screen.findByText('Signature Wedding')).toBeInTheDocument();
    /* Regex, not a string: the amount and the word are separate JSX expression
     * containers, so the element's text is "500.00 deposit" but no single text
     * node holds that. `depositMinor: 50_000` renders as 500.00 because amounts
     * are minor units divided by 100. */
    expect(await screen.findByText(/500\.00\s*deposit/)).toBeInTheDocument();
  });

  it('shows a photographer the client who booked', async () => {
    mockRoutes(state, { '/bookings': { bookings: [booking()] } });

    renderAt('/dashboard/bookings');

    expect(await screen.findByRole('heading', { name: 'Bookings' })).toBeInTheDocument();
    expect(await screen.findByText('Mia Rai')).toBeInTheDocument();
    /* The other party's name replaces the reference as the identifying line. */
    expect(await screen.findByText('LF-BK-8FK2QW')).toBeInTheDocument();
  });

  it('falls back gracefully when a party is an unpopulated id', async () => {
    mockSession(state, { role: 'client', name: 'Mia' });
    mockRoutes(state, { '/bookings': { bookings: [booking({ photographerId: 'p1' })] } });

    renderAt('/me/bookings');

    /* A bare id must not render as "[object Object]" or as an id. */
    expect(await screen.findByText('Your photographer')).toBeInTheDocument();
    expect(screen.queryByText('[object Object]')).not.toBeInTheDocument();
  });
});

describe('dashboard', () => {
  it('lists upcoming shoots with the client and package', async () => {
    mockRoutes(state, {
      '/analytics/summary': {
        bookings: { total: 8, byStatus: {}, bookedMinor: 500_000, conversion: 62.5 },
        revenue: { receivedMinor: 300_000, transactions: 6, outstandingMinor: 0, outstandingInvoices: 0 },
        projects: 5,
        clients: 4,
      },
      '/bookings': {
        bookings: [
          {
            _id: 'b1',
            reference: 'LF-BK-1',
            eventType: 'Wedding',
            eventDate: '2026-06-01T00:00:00.000Z',
            startTime: '10:00',
            location: 'Kathmandu',
            status: 'approved',
            clientId: { _id: 'c1', name: 'Mia Rai' },
            priceSnapshot: { packageName: 'Signature Wedding', totalMinor: 250_000 },
          },
        ],
      },
    });

    renderAt('/dashboard');

    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Upcoming shoots' })).toBeInTheDocument();
    expect(await screen.findByText('Signature Wedding')).toBeInTheDocument();
    /* Name and location are separate expression containers, so the <p> reads
     * "Mia Rai · Kathmandu"; matched by regex rather than exact text. */
    expect(await screen.findByText(/Mia Rai/)).toBeInTheDocument();
    expect(await screen.findByText(/Kathmandu/)).toBeInTheDocument();
  });

  it('asks the server for what is upcoming instead of filtering locally', async () => {
    mockRoutes(state, {
      '/analytics/summary': {
        bookings: { total: 0, byStatus: {}, bookedMinor: 0, conversion: 0 },
        revenue: { receivedMinor: 0, transactions: 0, outstandingMinor: 0, outstandingInvoices: 0 },
        projects: 0,
        clients: 0,
      },
      '/bookings': { bookings: [] },
    });

    renderAt('/dashboard');
    await screen.findByRole('heading', { name: 'Overview' });

    await waitFor(() => {
      const call = state.calls.filter((entry) => entry.url === '/bookings').at(-1);
      /* `from` is the cutoff; without it the endpoint returns all bookings,
       * including last year's. */
      expect(call?.params.from).toBeTruthy();
      expect(call?.params.limit).toBe(5);
    });
  });

  it('says so when nothing is scheduled', async () => {
    mockRoutes(state, {
      '/analytics/summary': {
        bookings: { total: 0, byStatus: {}, bookedMinor: 0, conversion: 0 },
        revenue: { receivedMinor: 0, transactions: 0, outstandingMinor: 0, outstandingInvoices: 0 },
        projects: 0,
        clients: 0,
      },
      '/bookings': { bookings: [] },
    });

    renderAt('/dashboard');

    expect(await screen.findByText('Nothing scheduled')).toBeInTheDocument();
  });
});

describe('portfolio management', () => {
  const items = {
    items: [
      {
        id: 'pf1',
        title: 'Golden Hour',
        description: '',
        category: 'wedding',
        width: 1600,
        height: 1067,
        aspectRatio: 1.5,
        blurDataUrl: null,
        thumbUrl: '/api/portfolio/image/pf1',
        largeUrl: '/api/portfolio/image/pf1?variant=large',
        sortOrder: 0,
        published: true,
        featured: false,
      },
      {
        id: 'pf2',
        title: 'Studio Portrait',
        description: '',
        category: 'portrait',
        width: 1200,
        height: 1600,
        aspectRatio: 0.75,
        blurDataUrl: null,
        thumbUrl: '/api/portfolio/image/pf2',
        largeUrl: '/api/portfolio/image/pf2?variant=large',
        sortOrder: 1,
        published: false,
        featured: false,
      },
    ],
    total: 2,
  };

  it('splits published work from drafts', async () => {
    mockRoutes(state, { '/portfolio': items });

    renderAt('/dashboard/portfolio');

    expect(await screen.findByRole('heading', { name: 'Portfolio' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Unpublish' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeInTheDocument();
  });

  it('filters to drafts only', async () => {
    mockRoutes(state, { '/portfolio': items });

    renderAt('/dashboard/portfolio');
    await screen.findByText('Golden Hour');

    await userEvent.click(screen.getByRole('tab', { name: 'Drafts' }));

    await waitFor(() => expect(screen.queryByText('Golden Hour')).not.toBeInTheDocument());
    expect(screen.getByText('Studio Portrait')).toBeInTheDocument();
  });
});