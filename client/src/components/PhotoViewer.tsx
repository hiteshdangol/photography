import { useCallback, useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';
import { withShareParams, type Photo } from '@/types/photo';

/**
 * Full-screen photo viewer.
 *
 * Built on a native `<dialog>` so focus trapping, the top layer and Escape are
 * handled by the browser rather than by hand. The gallery is keyboard-first:
 * arrows move, Escape closes, and focus returns to whatever opened it.
 */

interface PhotoViewerProps {
  photos: Photo[];
  /** Index into `photos`, or null when closed. */
  index: number | null;
  onClose: () => void;
  onNavigate: (index: number) => void;
  token?: string;
  viewToken?: string;
  /** Hides the download control for a gallery that forbids it. */
  allowDownload?: boolean;
  /** Shows a "remove" control, used by the favourites screen. */
  onRemove?: (photo: Photo) => void;
}

export function PhotoViewer({
  photos,
  index,
  onClose,
  onNavigate,
  token,
  viewToken,
  allowDownload = false,
  onRemove,
}: PhotoViewerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const open = index !== null;
  const photo = open ? photos[index] : null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      // Remember the trigger so focus can go back where it came from.
      openerRef.current = document.activeElement as HTMLElement | null;
      // Not every environment implements the modal dialog methods (jsdom does
      // not), so fall back to the plain attribute rather than throwing and
      // taking the whole page down over a missing convenience method.
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    } else if (!open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  }, [open]);

  const handleClose = useCallback(() => {
    // Fires for Escape too, so route it back through the caller instead of
    // relying on the button alone.
    onClose();
    openerRef.current?.focus?.();
  }, [onClose]);

  const go = useCallback(
    (delta: number) => {
      if (index === null || photos.length === 0) return;
      const next = index + delta;
      // Wrap, so a gallery never dead-ends on the last frame.
      onNavigate((next + photos.length) % photos.length);
    },
    [index, photos.length, onNavigate],
  );

  useEffect(() => {
    if (!open) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        go(1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        go(-1);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, go]);

  const src = photo ? withShareParams(photo.urls.gallery, token, viewToken) : '';
  const original = photo ? withShareParams(photo.urls.original, token, viewToken) : '';

  return (
    <dialog
      ref={dialogRef}
      onClose={handleClose}
      onCancel={handleClose}
      className="m-auto h-full max-h-full w-full max-w-full bg-ink-950/95 p-0 text-white backdrop:bg-ink-950/90 backdrop:backdrop-blur-sm"
      aria-label={photo?.caption || 'Photo viewer'}
    >
      {photo && (
        <div className="flex h-full flex-col">
          <header className="flex items-center justify-between gap-4 p-4">
            <p className="text-sm text-ink-300">
              {(index ?? 0) + 1} / {photos.length}
            </p>
            <div className="flex items-center gap-2">
              {onRemove && (
                <button
                  type="button"
                  onClick={() => onRemove(photo)}
                  aria-label="Remove from favourites"
                  className="rounded-md border border-ink-700 px-3 py-1.5 text-xs text-ink-200 transition-colors hover:border-rose-400 hover:text-rose-300"
                >
                  Remove
                </button>
              )}
              {allowDownload && (
                <a
                  href={original}
                  download
                  className="rounded-md border border-ink-700 px-3 py-1.5 text-xs text-ink-200 transition-colors hover:border-amber-400 hover:text-amber-300"
                >
                  Download
                </a>
              )}
              <button
                type="button"
                onClick={handleClose}
                aria-label="Close viewer"
                className="rounded-md border border-ink-700 px-3 py-1.5 text-xs text-ink-200 transition-colors hover:border-amber-400 hover:text-amber-300"
              >
                Close
              </button>
            </div>
          </header>

          <div className="relative flex min-h-0 flex-1 items-center justify-center px-4 pb-4">
            <img
              key={photo.id}
              src={src}
              alt={photo.caption || ''}
              className="max-h-full max-w-full animate-image-reveal object-contain"
            />

            {photos.length > 1 && (
              <>
                <ViewerArrow side="left" onClick={() => go(-1)} />
                <ViewerArrow side="right" onClick={() => go(1)} />
              </>
            )}
          </div>

          {photo.caption && (
            <footer className="border-t border-ink-800 p-4 text-center text-sm text-ink-300">
              {photo.caption}
            </footer>
          )}
        </div>
      )}
    </dialog>
  );
}

function ViewerArrow({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === 'left' ? 'Previous photo' : 'Next photo'}
      className={cn(
        'absolute top-1/2 -translate-y-1/2 rounded-full border border-ink-700 bg-ink-950/60 p-3 text-ink-200 backdrop-blur transition-colors hover:border-amber-400 hover:text-amber-300',
        side === 'left' ? 'left-2' : 'right-2',
      )}
    >
      {side === 'left' ? '‹' : '›'}
    </button>
  );
}