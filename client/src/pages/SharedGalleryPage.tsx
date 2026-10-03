import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams, Link } from 'react-router-dom';
import { request, errorMessage } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { Badge, Card, EmptyState, PageLoader, Tabs } from '@/components/ui';
import { PhotoGrid, PhotoGridSkeleton } from '@/components/PhotoGrid';
import { PhotoViewer } from '@/components/PhotoViewer';
import type { PhotoListResponse, SharedGallery } from '@/types/photo';

/**
 * Public shared gallery, reached at `/g/:token`.
 *
 * This is the whole point of a share link: the recipient is usually not the
 * person who booked the shoot, and often has no account at all. So the gallery
 * works signed out - the server authorises every request with the token, and the
 * token is carried on the image URLs too, not just the metadata fetch.
 *
 * Sign-in is prompted for, never required, so a guest can browse a gallery and
 * then decide whether to create an account to favourite or download.
 */

type Section = 'gallery' | 'highlights';

export function SharedGalleryPage() {
  const { token } = useParams<{ token: string }>();
  const { status } = useAuth();
  const [section, setSection] = useState<Section>('highlights');
  const [viewerPhotoId, setViewerPhotoId] = useState<string | null>(null);

  const gallery = useQuery({
    queryKey: ['share', token],
    queryFn: () => request<SharedGallery>({ url: '/shares/resolve', params: { token } }),
    enabled: Boolean(token),
    // A revoked or expired link must not sit in the cache showing a gallery that
    // no longer exists; the owner can revoke one mid-browse.
    refetchOnWindowFocus: true,
  });

  const projectId = gallery.data?.project.id;
  const viewToken = gallery.data?.viewToken;

  const photos = useQuery({
    queryKey: ['share', token, section, viewToken],
    queryFn: () =>
      request<PhotoListResponse>({
        url: '/photos',
        params: {
          projectId,
          token,
          viewToken,
          ...(section === 'highlights' ? { highlights: 'true', limit: 60 } : { limit: 200 }),
        },
      }),
    enabled: Boolean(projectId) && Boolean(token),
  });

  if (gallery.isPending) return <PageLoader />;

  if (gallery.isError) {
    return (
      <div className="mx-auto max-w-2xl py-16">
        <EmptyState
          title="This gallery link is not available."
          hint={errorMessage(
            gallery.error,
            'It may have expired or been turned off. Ask your photographer for a new link.',
          )}
        />
      </div>
    );
  }

  const { project, viewer } = gallery.data!;
  const list = photos.data?.photos ?? [];
  const viewerIndex = viewerPhotoId ? list.findIndex((photo) => photo.id === viewerPhotoId) : null;

  // A share link never grants originals, whatever the project policy says.
  return (
    <div className="mx-auto max-w-6xl space-y-8 py-8">
      <header className="space-y-3 text-center">
        <p className="text-xs uppercase tracking-[0.2em] text-ink-500">Private gallery</p>
        <h1 className="text-display text-4xl font-semibold tracking-tight text-white">{project.title}</h1>
        <p className="text-sm text-ink-400">
          {project.eventDate ? new Date(project.eventDate).toLocaleDateString() : null}
          {project.counts.photos ? ` · ${project.counts.photos} photographs` : ''}
        </p>
        <Badge tone="neutral">shared link</Badge>
      </header>

      {/*
        Browsing works without an account. Ask for one only where it is needed -
        a wall here would make a shared link useless to the friend it was sent to.
      */}
      {status !== 'authenticated' && (
        <Card className="flex flex-wrap items-center justify-between gap-4 text-left">
          <p className="text-sm text-ink-300">
            {viewer.role === 'guest'
              ? 'Create an account to save favourites and request your album.'
              : 'Sign in to see your saved photos.'}
          </p>
          <div className="flex gap-2">
            <Link
              to="/register"
              className="rounded-md bg-amber-400 px-3 py-1.5 text-sm font-medium text-ink-950 transition-colors hover:bg-amber-300"
            >
              Create account
            </Link>
            <Link
              to="/login"
              state={{ from: `/g/${token}` }}
              className="rounded-md border border-ink-700 px-3 py-1.5 text-sm text-ink-200 transition-colors hover:border-amber-400 hover:text-amber-300"
            >
              Sign in
            </Link>
          </div>
        </Card>
      )}

      <Tabs
        items={[
          { value: 'highlights', label: 'Highlights' },
          { value: 'gallery', label: `All photos${project.counts.photos ? ` (${project.counts.photos})` : ''}` },
        ]}
        value={section}
        onChange={(next) => setSection(next as Section)}
      />

      {photos.isPending ? (
        <PhotoGridSkeleton />
      ) : photos.isError ? (
        <EmptyState
          title="We could not load these photos."
          hint={errorMessage(photos.error, 'The link may have stopped working while you were reading.')}
        />
      ) : list.length === 0 ? (
        <EmptyState
          title={section === 'highlights' ? 'No highlights selected yet.' : 'No photos yet.'}
          hint="Check back soon - the photographer adds these as the edit comes together."
        />
      ) : (
        <PhotoGrid
          photos={list}
          token={token}
          viewToken={viewToken}
          onSelect={(photo) => setViewerPhotoId(photo.id)}
        />
      )}

      <PhotoViewer
        photos={list}
        index={viewerIndex}
        token={token}
        viewToken={viewToken}
        onClose={() => setViewerPhotoId(null)}
        onNavigate={(next) => setViewerPhotoId(list[next]?.id ?? null)}
        allowDownload={false}
      />
    </div>
  );
}