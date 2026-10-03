import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from '@/App';
import { AuthProvider } from '@/context/AuthContext';
import { mockFailures, mockRoutes, mockSession, resetState, type HarnessState } from './harness';

/**
 * The gallery surface: a shared link that works signed out, a project page with
 * a working photo grid and viewer, and the favourites list.
 *
 * The share route is the one that has to survive having no session at all. Its
 * regression is specific: it used to live behind `RequireAuth`, which redirected
 * anonymous recipients to `/login` - so every link a photographer ever sent to a
 * non-client landed on a sign-in form instead of the photographs.
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

function photo(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    projectId: 'project-1',
    albumId: null,
    category: 'other',
    caption: `Photo ${id}`,
    isHighlight: false,
    highlightOrder: 0,
    width: 2000,
    height: 1333,
    aspectRatio: 1.5,
    blurDataUrl: '',
    dominantColor: '#1a1a1a',
    uploadedAt: '2026-01-01T00:00:00.000Z',
    urls: {
      thumbnail: `/api/photos/${id}/file?variant=thumbnail`,
      gallery: `/api/photos/${id}/file?variant=gallery`,
      original: `/api/photos/${id}/file?variant=original`,
    },
    ...overrides,
  };
}

const sharedGallery = {
  project: {
    id: 'project-1',
    title: 'Autumn Wedding',
    slug: 'autumn-wedding',
    eventDate: '2026-05-02T00:00:00.000Z',
    status: 'delivered',
    coverPhotoId: null,
    counts: { photos: 2, highlights: 2 },
  },
  share: {
    id: 'share-1',
    label: 'For Mia',
    expiresAt: null,
    maxAccesses: 0,
    accessCount: 1,
  },
  viewer: { role: 'guest', signedIn: false },
  viewToken: 'view-grant-abc',
};

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

describe('shared gallery link', () => {
  it('renders the gallery for a visitor with no session', async () => {
    // A failing /auth/me is how the app learns nobody is signed in, which is
    // exactly the recipient of a share link.
    mockFailures(state, { '/auth/me': 'unauthenticated' });
    mockRoutes(state, {
      '/shares/resolve': sharedGallery,
      '/photos': { photos: [photo('p1'), photo('p2')], count: 2 },
    });

    renderAt('/g/share-token-123');

    // The heading proves we got the gallery rather than a sign-in form.
    expect(await screen.findByRole('heading', { name: 'Autumn Wedding' })).toBeInTheDocument();
  });

  it('resolves the token and lists photos with it', async () => {
    mockRoutes(state, {
      '/shares/resolve': sharedGallery,
      '/photos': { photos: [photo('p1')], count: 1 },
    });

    renderAt('/g/share-token-123');
    await screen.findByRole('heading', { name: 'Autumn Wedding' });

    await waitFor(() => {
      expect(state.urls).toContain('/shares/resolve');
      expect(state.urls).toContain('/photos');
    });
  });

  it('carries the token onto image requests, or every tile would 403', async () => {
    mockFailures(state, { '/auth/me': 'unauthenticated' });
    mockRoutes(state, {
      '/shares/resolve': sharedGallery,
      '/photos': { photos: [photo('p1'), photo('p2')], count: 2 },
    });

    const { container } = renderAt('/g/share-token-123');
    await screen.findByRole('heading', { name: 'Autumn Wedding' });

    const images = await waitFor(() => {
      const found = container.querySelectorAll('img[src*="variant=thumbnail"]');
      expect(found.length).toBeGreaterThan(0);
      return found;
    });

    // Authorisation for bytes is checked separately from metadata, so the token
    // has to be on the `<img>` too.
    for (const image of Array.from(images)) {
      const src = image.getAttribute('src') ?? '';
      expect(src).toContain('token=share-token-123');
      expect(src).toContain('viewToken=view-grant-abc');
    }
  });

  it('offers sign-up rather than blocking the gallery', async () => {
    mockFailures(state, { '/auth/me': 'unauthenticated' });
    mockRoutes(state, {
      '/shares/resolve': sharedGallery,
      '/photos': { photos: [photo('p1')], count: 1 },
    });

    renderAt('/g/share-token-123');
    await screen.findByRole('heading', { name: 'Autumn Wedding' });

    expect(screen.getByRole('link', { name: /create account/i })).toBeInTheDocument();
    // And the photos themselves are still on screen.
    expect(await screen.findAllByRole('button', { name: /photo p1/i })).toHaveLength(1);
  });

  it('explains an expired link instead of showing an empty gallery', async () => {
    mockFailures(state, {
      '/shares/resolve': 'This gallery link has expired. Ask your photographer for a new one.',
    });

    renderAt('/g/share-token-123');

    expect(await screen.findByText(/link is not available/i)).toBeInTheDocument();
    // The server's reason is surfaced, so the recipient knows what to do.
    expect(screen.getByText(/has expired/i)).toBeInTheDocument();
    // And no photos are claimed to be missing when the link is simply dead.
    expect(screen.queryByRole('button', { name: /photo p1/i })).not.toBeInTheDocument();
  });

  it('reports a link that stopped working mid-browse', async () => {
    mockRoutes(state, {
      '/shares/resolve': sharedGallery,
      '/photos': { photos: [], count: 0 },
    });
    mockFailures(state, { '/photos': 'This link has reached its access limit.' });

    renderAt('/g/share-token-123');
    await screen.findByRole('heading', { name: 'Autumn Wedding' });

    expect(await screen.findByText(/could not load these photos/i)).toBeInTheDocument();
  });
});

describe('project page', () => {
  const project = {
    project: {
      _id: 'project-1',
      title: 'Autumn Wedding',
      description: 'Two days at the coast.',
      location: 'Whitby',
      status: 'delivered',
      eventDate: '2026-05-02T00:00:00.000Z',
      timelineStage: 'gallery_published',
      gallery: {
        published: true,
        totalPhotos: 3,
        highlightsCount: 2,
        allowClientDownloads: true,
        allowOriginalDownloads: false,
      },
    },
    timeline: {
      stages: [
        { key: 'booking_requested', label: 'Booking Requested', short: 'Requested' },
        { key: 'gallery_published', label: 'Gallery Published', short: 'Gallery' },
      ],
      current: 'gallery_published',
      currentIndex: 1,
      completed: false,
      percent: 100,
      events: [
        {
          id: 'ev-1',
          stage: 'gallery_published',
          title: 'Gallery published',
          description: '12 photos published to the private gallery.',
          automatic: true,
          occurredAt: '2026-06-01T10:00:00.000Z',
        },
      ],
    },
    albums: [{ _id: 'album-1', name: 'Ceremony', description: 'The vows', counts: { photos: 1 } }],
    viewerRole: 'photographer',
  };

  it('shows the project with its status and event date', async () => {
    mockSession(state, { role: 'client', name: 'Mia' });
    mockRoutes(state, {
      '/projects/project-1': project,
      '/photos': { photos: [photo('p1', { albumId: 'album-1' }), photo('p2')], count: 2 },
    });

    renderAt('/projects/project-1');

    expect(await screen.findByRole('heading', { name: 'Autumn Wedding' })).toBeInTheDocument();
    expect(screen.getByText(/whitby/i)).toBeInTheDocument();
  });

  it('renders the timeline when that section is chosen', async () => {
    mockSession(state, { role: 'client', name: 'Mia' });
    mockRoutes(state, {
      '/projects/project-1': project,
      '/photos': { photos: [photo('p1')], count: 1 },
    });

    const user = userEvent.setup();
    renderAt('/projects/project-1');
    await screen.findByRole('heading', { name: 'Autumn Wedding' });

    await user.click(screen.getByRole('tab', { name: 'Timeline' }));

    expect(await screen.findByText('Gallery published')).toBeInTheDocument();
    expect(screen.getByText(/12 photos published/)).toBeInTheDocument();
  });

  it('groups photos under the album they belong to', async () => {
    mockSession(state, { role: 'client', name: 'Mia' });
    mockRoutes(state, {
      '/projects/project-1': project,
      '/photos': { photos: [photo('p1', { albumId: 'album-1' }), photo('p2')], count: 2 },
    });

    const user = userEvent.setup();
    renderAt('/projects/project-1');
    await screen.findByRole('heading', { name: 'Autumn Wedding' });

    await user.click(screen.getByRole('tab', { name: 'Albums' }));

    expect(await screen.findByRole('heading', { name: 'Ceremony' })).toBeInTheDocument();
    expect(screen.getByText(/not in an album/i)).toBeInTheDocument();
  });

  it('opens a photo in the viewer and closes it again', async () => {
    mockSession(state, { role: 'client', name: 'Mia' });
    mockRoutes(state, {
      '/projects/project-1': project,
      '/photos': { photos: [photo('p1'), photo('p2')], count: 2 },
    });

    const user = userEvent.setup();
    renderAt('/projects/project-1');
    await screen.findByRole('heading', { name: 'Autumn Wedding' });

    await user.click(screen.getByRole('button', { name: /photo p1/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('img', { name: 'Photo p1' })).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /close viewer/i }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});

describe('favourites', () => {
  it('lists saved photos and removes one', async () => {
    mockSession(state, { role: 'client', name: 'Mia' });
    mockRoutes(state, {
      '/favorites': { favorites: [photo('p1'), photo('p2')], count: 2 },
    });

    const user = userEvent.setup();
    renderAt('/me/favorites');

    expect(await screen.findByRole('button', { name: /photo p1/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /photo p2/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /photo p1/i }));

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /remove from favourites/i }));

    await waitFor(() => {
      expect(state.urls).toContain('/favorites');
    });
  });

  it('prompts rather than showing a broken grid when empty', async () => {
    mockSession(state, { role: 'client', name: 'Mia' });
    mockRoutes(state, { '/favorites': { favorites: [], count: 0 } });

    renderAt('/me/favorites');

    expect(await screen.findByText(/nothing saved yet/i)).toBeInTheDocument();
  });
});