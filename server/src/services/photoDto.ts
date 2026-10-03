/**
 * The single definition of a photo as the client sees it.
 *
 * Lives outside `photo.routes.ts` because the gallery and the favourites list
 * both render the same component from the same payload. Two copies of this
 * shape would drift the moment a field was added, and the bug would only show up
 * as a blank caption in one of the two screens.
 */

export interface PhotoLike {
  _id: unknown;
  projectId: unknown;
  /** Null until a photo is filed into an album. Lets the client group without a second call. */
  albumId?: unknown;
  category: string;
  caption: string;
  isHighlight: boolean;
  highlightOrder: number;
  width: number;
  height: number;
  aspectRatio: number;
  blurDataUrl: string;
  dominantColor: string;
  allowDownload: boolean;
  allowOriginalDownload: boolean;
  uploadedAt: Date;
}

/**
 * Storage keys are never exposed - only authorised URLs through
 * `/photos/:id/file`, which re-checks access on every request.
 */
export function toPhotoDto(photo: PhotoLike) {
  const id = String(photo._id);
  return {
    id,
    projectId: String(photo.projectId),
    albumId: photo.albumId ? String(photo.albumId) : null,
    category: photo.category,
    caption: photo.caption,
    isHighlight: photo.isHighlight,
    highlightOrder: photo.highlightOrder,
    width: photo.width,
    height: photo.height,
    aspectRatio: photo.aspectRatio,
    blurDataUrl: photo.blurDataUrl,
    dominantColor: photo.dominantColor,
    uploadedAt: photo.uploadedAt,
    urls: {
      thumbnail: `/api/photos/${id}/file?variant=thumbnail`,
      gallery: `/api/photos/${id}/file?variant=gallery`,
      original: `/api/photos/${id}/file?variant=original`,
    },
  };
}