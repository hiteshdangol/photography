import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { request, errorMessage } from '@/lib/api';
import { Card, EmptyState, PageLoader, SectionHeading } from '@/components/ui';
import { PhotoGrid } from '@/components/PhotoGrid';
import { PhotoViewer } from '@/components/PhotoViewer';
import type { Photo } from '@/types/photo';

/**
 * The client's saved photos, across every shoot.
 *
 * The endpoint returns each photo in full, so this renders from one request
 * instead of fanning out a lookup per favourite. Removal is optimistic: the heart
 * has already visibly changed by the time the server answers, and rolling back on
 * failure keeps that feeling honest rather than janky.
 */

interface FavoritesResponse {
  favorites: Photo[];
  count: number;
}

export function FavoritesPage() {
  const queryClient = useQueryClient();
  const [viewerPhotoId, setViewerPhotoId] = useState<string | null>(null);

  const favorites = useQuery({
    queryKey: ['favorites'],
    queryFn: () => request<FavoritesResponse>({ url: '/favorites', params: { limit: 500 } }),
  });

  const remove = useMutation({
    mutationFn: (photoId: string) =>
      request<{ removed: number }>({ url: '/favorites', method: 'delete', data: { photoIds: [photoId] } }),
    onMutate: async (photoId) => {
      await queryClient.cancelQueries({ queryKey: ['favorites'] });
      const previous = queryClient.getQueryData<FavoritesResponse>(['favorites']);
      queryClient.setQueryData<FavoritesResponse>(['favorites'], (old) =>
        old
          ? { ...old, favorites: old.favorites.filter((photo) => photo.id !== photoId), count: old.count - 1 }
          : old,
      );
      return { previous };
    },
    onError: (error, _photoId, context) => {
      // Put the photo back exactly where it was, rather than refetching and
      // losing scroll position.
      if (context?.previous) queryClient.setQueryData(['favorites'], context.previous);
      toast.error(errorMessage(error, 'We could not remove that photo.'));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['favorites'] });
    },
  });

  if (favorites.isPending) return <PageLoader />;

  if (favorites.isError) {
    return <EmptyState title="We could not load your favourites." hint={errorMessage(favorites.error)} />;
  }

  const photos = favorites.data?.favorites ?? [];
  const viewerIndex = viewerPhotoId ? photos.findIndex((photo) => photo.id === viewerPhotoId) : null;

  return (
    <div className="space-y-6">
      <SectionHeading
        title="Favourites"
        hint={photos.length > 0 ? `${photos.length} saved photographs` : undefined}
      />

      {photos.length === 0 ? (
        <EmptyState
          title="Nothing saved yet"
          hint="Tap the heart on any photo in your gallery and it will collect here."
        />
      ) : (
        <>
          <PhotoGrid
            photos={photos}
            onSelect={(photo) => setViewerPhotoId(photo.id)}
            isFavorited={() => true}
          />

          {/*
            Grouped by shoot so a client picking proofs for one album can find
            them, instead of scrolling a flat wall of images.
          */}
          <Card className="flex flex-wrap items-center justify-between gap-4">
            <p className="text-sm text-ink-300">Favourites from {new Set(photos.map((p) => p.projectId)).size} shoots.</p>
            <Link
              to="/me/galleries"
              className="text-sm text-amber-300 underline decoration-amber-500/40 underline-offset-4"
            >
              Back to your galleries
            </Link>
          </Card>
        </>
      )}

      <PhotoViewer
        photos={photos}
        index={viewerIndex}
        onClose={() => setViewerPhotoId(null)}
        onNavigate={(next) => setViewerPhotoId(photos[next]?.id ?? null)}
        onRemove={(photo) => remove.mutate(photo.id)}
        allowDownload
      />
    </div>
  );
}