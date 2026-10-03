import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams, Link } from 'react-router-dom';
import { request, errorMessage } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { Badge, Card, EmptyState, PageLoader, SectionHeading, Tabs, toneForStatus } from '@/components/ui';
import { PhotoGrid, PhotoGridSkeleton } from '@/components/PhotoGrid';
import { PhotoViewer } from '@/components/PhotoViewer';
import { ProjectTimeline } from '@/components/ProjectTimeline';
import type { Photo, PhotoListResponse, Timeline } from '@/types/photo';

/**
 * Canonical project route.
 *
 * One page owns everything that happens to a shoot - highlights reel, full
 * gallery, album selection and the timeline - because that is how the work
 * actually progresses. The section is in the URL so a client can send a link
 * straight to "just the photos".
 */

interface Album {
  _id: string;
  name: string;
  description?: string;
  coverPhotoId?: string | null;
  counts: { photos: number };
}

interface ProjectResponse {
  project: {
    _id: string;
    title: string;
    description?: string;
    location?: string;
    status: string;
    eventDate: string | null;
    timelineStage: string;
    gallery: {
      published: boolean;
      totalPhotos: number;
      highlightsCount: number;
      allowClientDownloads: boolean;
      allowOriginalDownloads: boolean;
    };
  };
  timeline: Timeline;
  albums: Album[];
  viewerRole: string;
}

type Section = 'highlights' | 'gallery' | 'albums' | 'timeline';

/** Highlights only exist once the photographer has released the reel. */
function highlightsVisible(project: ProjectResponse['project']): boolean {
  return project.gallery.published || project.gallery.highlightsCount > 0;
}

export function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { user } = useAuth();
  const [section, setSection] = useState<Section>('highlights');
  /**
   * The viewer tracks a photo id, not an index. The album grid hands back an
   * index into its own subset, which would open the wrong frame.
   */
  const [viewerPhotoId, setViewerPhotoId] = useState<string | null>(null);

  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => request<ProjectResponse>({ url: `/projects/${projectId}` }),
    enabled: Boolean(projectId),
  });

  const wantsHighlights = section === 'highlights' || !project.data;

  const photos = useQuery({
    queryKey: ['project', projectId, 'photos', section, wantsHighlights],
    queryFn: () =>
      request<PhotoListResponse>({
        url: '/photos',
        params: {
          projectId,
          // The reels are small and hand-picked; the gallery is everything.
          ...(wantsHighlights ? { highlights: 'true', limit: 60 } : { limit: 200 }),
        },
      }),
    enabled: Boolean(projectId) && section !== 'timeline',
  });

  if (project.isPending) return <PageLoader />;

  if (project.isError) {
    return (
      <EmptyState
        title="We could not open that project."
        hint={errorMessage(project.error, 'It may have been removed, or it may not be yours to view.')}
      />
    );
  }

  const data = project.data;
  const list = photos.data?.photos ?? [];
  const viewerIndex = viewerPhotoId ? list.findIndex((photo) => photo.id === viewerPhotoId) : null;
  const isPhotographer = data.viewerRole === 'photographer';
  const allowDownload = isPhotographer || data.project.gallery.allowClientDownloads;

  // A client landing on "highlights" before the reel is released should see the
  // gallery, not an empty screen.
  const effectiveSection =
    section === 'highlights' && !highlightsVisible(data.project) ? 'gallery' : section;

  const tabs = [
    ...(highlightsVisible(data.project) ? [{ value: 'highlights', label: 'Highlights' }] : []),
    {
      value: 'gallery',
      label: `Gallery${data.project.gallery.totalPhotos ? ` (${data.project.gallery.totalPhotos})` : ''}`,
    },
    { value: 'albums', label: 'Albums' },
    { value: 'timeline', label: 'Timeline' },
  ];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-ink-500">Project</p>
          <h1 className="text-display text-3xl font-semibold tracking-tight text-white">
            {data.project.title}
          </h1>
          <p className="mt-1 text-sm text-ink-400">
            {data.project.eventDate ? new Date(data.project.eventDate).toLocaleDateString() : 'Date to be confirmed'}
            {data.project.location ? ` · ${data.project.location}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={toneForStatus(data.project.status)}>{data.project.status}</Badge>
          {data.project.gallery.published ? (
            <Badge tone="emerald">gallery live</Badge>
          ) : (
            <Badge tone="neutral">not published</Badge>
          )}
          {isPhotographer && (
            <Link
              to="/dashboard/projects"
              className="text-xs text-ink-300 underline decoration-ink-600 underline-offset-4 hover:text-amber-300"
            >
              Manage
            </Link>
          )}
        </div>
      </header>

      {data.project.description && (
        <p className="max-w-2xl text-sm text-ink-300">{data.project.description}</p>
      )}

      <Tabs items={tabs} value={effectiveSection} onChange={(next) => setSection(next as Section)} />

      {effectiveSection === 'albums' && (
        <AlbumsSection
          albums={data.albums}
          photos={list}
          loading={photos.isPending}
          onSelectPhoto={(photo) => setViewerPhotoId(photo.id)}
        />
      )}

      {effectiveSection === 'timeline' && <ProjectTimeline timeline={data.timeline} />}

      {(effectiveSection === 'highlights' || effectiveSection === 'gallery') && (
        <>
          {photos.isPending ? (
            <PhotoGridSkeleton />
          ) : photos.isError ? (
            <EmptyState title="We could not load the photos." hint={errorMessage(photos.error)} />
          ) : list.length === 0 ? (
            <EmptyState
              title={effectiveSection === 'highlights' ? 'No highlights yet.' : 'No photos yet.'}
              hint={
                isPhotographer
                  ? 'Upload photos and mark the best ones as highlights.'
                  : 'Your photographer has not published anything here yet.'
              }
            />
          ) : (
            <PhotoGrid photos={list} onSelect={(photo) => setViewerPhotoId(photo.id)} />
          )}
        </>
      )}

      <PhotoViewer
        photos={list}
        index={viewerIndex}
        onClose={() => setViewerPhotoId(null)}
        onNavigate={(next) => setViewerPhotoId(list[next]?.id ?? null)}
        allowDownload={allowDownload}
      />

      {!isPhotographer && user?.role === 'client' && list.length > 0 && (
        <Card className="flex flex-wrap items-center justify-between gap-4">
          <p className="text-sm text-ink-300">
            Found the ones you want? Favourites are saved to your account.
          </p>
          <Link
            to="/me/favorites"
            className="text-sm text-amber-300 underline decoration-amber-500/40 underline-offset-4"
          >
            View favourites
          </Link>
        </Card>
      )}
    </div>
  );
}

interface AlbumsSectionProps {
  albums: Album[];
  photos: Photo[];
  loading: boolean;
  onSelectPhoto: (photo: Photo) => void;
}

function AlbumsSection({ albums, photos, loading, onSelectPhoto }: AlbumsSectionProps) {
  if (loading) return <PhotoGridSkeleton count={6} />;

  if (albums.length === 0) {
    return <EmptyState title="No albums yet." hint="Albums group a shoot into chapters." />;
  }

  // Grouped here rather than with a request per album: the photos are already
  // loaded for the gallery, and `albumId` on the DTO makes a second fetch per
  // album pure waste.
  const byAlbum = new Map<string, Photo[]>();
  const unfiled: Photo[] = [];
  for (const photo of photos) {
    if (!photo.albumId) {
      unfiled.push(photo);
      continue;
    }
    const bucket = byAlbum.get(photo.albumId);
    if (bucket) bucket.push(photo);
    else byAlbum.set(photo.albumId, [photo]);
  }

  return (
    <div className="space-y-8">
      {albums.map((album) => {
        const albumPhotos = byAlbum.get(album._id) ?? [];
        return (
          <section key={album._id} className="space-y-3">
            <SectionHeading
              title={album.name}
              hint={album.description}
              action={<Badge tone="neutral">{albumPhotos.length} photos</Badge>}
            />
            {albumPhotos.length === 0 ? (
              <p className="text-sm text-ink-500">No photos in this album yet.</p>
            ) : (
              <PhotoGrid photos={albumPhotos} onSelect={onSelectPhoto} />
            )}
          </section>
        );
      })}

      {unfiled.length > 0 && (
        <section className="space-y-3">
          <SectionHeading title="Not in an album" hint="Waiting to be filed." />
          <PhotoGrid photos={unfiled} onSelect={onSelectPhoto} />
        </section>
      )}
    </div>
  );
}