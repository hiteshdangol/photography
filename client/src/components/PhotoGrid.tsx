import { useMemo } from 'react';
import { cn } from '@/lib/cn';
import { withShareParams, type Photo } from '@/types/photo';
import { Skeleton } from '@/components/ui';

/**
 * Masonry photo grid.
 *
 * Tiles are sized from each photo's `aspectRatio` before the file loads, so the
 * layout never reflows as images arrive - a grid that reflows while a client is
 * trying to tap their favourites is unusable. Columns are a CSS grid with
 * `grid-auto-rows` in row units and each tile spanning as many rows as its ratio
 * needs, which keeps the DOM flat instead of splitting into columns.
 */

interface PhotoGridProps {
  photos: Photo[];
  /** Appended to every image URL; required when reading a shared gallery. */
  token?: string;
  viewToken?: string;
  onSelect?: (photo: Photo, index: number) => void;
  /** Marks a photo the current user has favourited. */
  isFavorited?: (photo: Photo) => boolean;
  className?: string;
  emptyState?: React.ReactNode;
}

/** One row unit in `grid-auto-rows`, in pixels. Smaller rows = tighter packing. */
const ROW_UNIT = 8;

export function PhotoGrid({
  photos,
  token,
  viewToken,
  onSelect,
  isFavorited,
  className,
  emptyState,
}: PhotoGridProps) {
  // A shared gallery needs the token on every image request, so the URL is
  // resolved once per render pass rather than inside each tile.
  const resolved = useMemo(
    () => photos.map((photo) => ({
      photo,
      thumbnail: withShareParams(photo.urls.thumbnail, token, viewToken),
    })),
    [photos, token, viewToken],
  );

  if (photos.length === 0) {
    return <>{emptyState}</>;
  }

  return (
    <div
      className={cn(
        'grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4',
        className,
      )}
      style={{ gridAutoRows: `${ROW_UNIT}px` }}
    >
      {resolved.map(({ photo, thumbnail }, index) => (
        <PhotoTile
          key={photo.id}
          photo={photo}
          src={thumbnail}
          onSelect={onSelect ? () => onSelect(photo, index) : undefined}
          favorited={isFavorited?.(photo) ?? false}
        />
      ))}
    </div>
  );
}

interface PhotoTileProps {
  photo: Photo;
  src: string;
  onSelect?: () => void;
  favorited: boolean;
}

function PhotoTile({ photo, src, onSelect, favorited }: PhotoTileProps) {
  // Spanning rows from the ratio is what produces the masonry effect: a wide
  // photo covers fewer rows than a tall one, so columns pack without gaps.
  const rowSpan = Math.max(
    6,
    Math.round((100 / Math.max(photo.aspectRatio, 0.2)) * ROW_UNIT * 0.24),
  );

  const interactive = Boolean(onSelect);

  return (
    <button
      type="button"
      onClick={onSelect}
      // A non-interactive tile stays out of the tab order rather than becoming a
      // disabled button, which screen readers announce as unavailable.
      tabIndex={interactive ? 0 : -1}
      aria-label={photo.caption || 'Photo'}
      style={{ gridRow: `span ${rowSpan}` }}
      className={cn(
        'group relative w-full overflow-hidden rounded-lg bg-ink-800 text-left focus-ring',
        'transition-transform duration-300 motion-safe:hover:scale-[1.015]',
        interactive && 'cursor-zoom-in',
      )}
    >
      {/*
        The dominant colour sits behind the image so a slow connection shows the
        gallery's palette instead of a grid of grey boxes.
      */}
      <span
        aria-hidden="true"
        className="absolute inset-0"
        style={{ backgroundColor: photo.dominantColor || '#1a1a1a' }}
      />
      {photo.blurDataUrl && (
        <img
          src={photo.blurDataUrl}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full scale-110 object-cover blur-xl"
        />
      )}
      <img
        src={src}
        alt={photo.caption || ''}
        loading="lazy"
        decoding="async"
        width={photo.width}
        height={photo.height}
        className="relative h-full w-full object-cover opacity-0 blur-sm transition-opacity duration-500 group-hover:scale-[1.03] data-[loaded=true]:opacity-100 data-[loaded=true]:blur-0"
        onLoad={(event) => {
          event.currentTarget.dataset.loaded = 'true';
        }}
      />

      {favorited && (
        <span
          aria-label="In your favourites"
          className="absolute right-2 top-2 rounded-full bg-ink-950/70 px-2 py-1 text-[10px] uppercase tracking-wide text-amber-300 backdrop-blur"
        >
          Saved
        </span>
      )}

      {photo.caption && (
        <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink-950/90 to-transparent p-3 pt-8 text-xs text-white opacity-0 transition-opacity duration-300 group-hover:opacity-100 group-focus-visible:opacity-100">
          {photo.caption}
        </span>
      )}
    </button>
  );
}

/** Placeholder grid with the same shape as the real one, to avoid a layout jump. */
export function PhotoGridSkeleton({ count = 12, className }: { count?: number; className?: string }) {
  return (
    <div
      className={cn('grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4', className)}
      aria-hidden="true"
    >
      {Array.from({ length: count }, (_unused, index) => (
        <Skeleton key={index} className="aspect-[3/4] w-full rounded-lg" />
      ))}
    </div>
  );
}