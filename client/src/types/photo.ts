/**
 * Mirrors the server's `toPhotoDto` in `server/src/services/photoDto.ts`.
 *
 * The server emits `urls` as relative paths through `/photos/:id/file`, which
 * re-checks access on every request. Append `token` (and `viewToken`) to those
 * paths when reading a shared gallery anonymously - see `withShareParams`.
 */

export interface PhotoUrls {
  thumbnail: string;
  gallery: string;
  original: string;
}

export interface Photo {
  id: string;
  projectId: string;
  /** Null until the photo is filed into an album. */
  albumId: string | null;
  category: string;
  caption: string;
  isHighlight: boolean;
  highlightOrder: number;
  width: number;
  height: number;
  /** width / height, precomputed so the grid can size tiles before loading. */
  aspectRatio: number;
  /** ~24px inline placeholder for the blur-up effect. */
  blurDataUrl: string;
  dominantColor: string;
  uploadedAt: string;
  urls: PhotoUrls;
  /** Present only on the favourites endpoint. */
  favoritedAt?: string | null;
}

export interface PhotoListResponse {
  photos: Photo[];
  count: number;
}

export type ShareViewerRole = 'photographer' | 'admin' | 'client' | 'guest';

export interface SharedGallery {
  project: {
    id: string;
    title: string;
    slug: string;
    eventDate: string | null;
    status: string;
    coverPhotoId: string | null;
    counts: { photos: number; highlights: number };
  };
  share: {
    id: string;
    label: string;
    expiresAt: string | null;
    maxAccesses: number;
    accessCount: number;
  };
  viewer: { role: ShareViewerRole; signedIn: boolean };
  /** Echoed back on photo reads so a spent access limit does not lock you out. */
  viewToken: string;
}

/** Mirrors `TimelineView` from `server/src/services/timeline/engine.ts`. */
export interface TimelineStage {
  key: string;
  label: string;
  short: string;
}

export interface TimelineEvent {
  id: string;
  stage: string;
  title: string;
  description: string;
  /** True when the engine advanced the stage, false for a manual note. */
  automatic: boolean;
  occurredAt: string;
}

export interface Timeline {
  stages: TimelineStage[];
  current: string;
  currentIndex: number;
  completed: boolean;
  percent: number;
  events: TimelineEvent[];
}

/**
 * Adds the share credentials to a photo URL.
 *
 * Image requests to `/photos/:id/file` are authorised independently of the
 * metadata request, so a shared gallery has to carry the token on the `<img>`
 * too - otherwise the list renders and every tile comes back 403.
 */
export function withShareParams(url: string, token?: string, viewToken?: string): string {
  if (!token) return url;
  const params = new URLSearchParams({ token });
  if (viewToken) params.set('viewToken', viewToken);
  return `${url}${url.includes('?') ? '&' : '?'}${params.toString()}`;
}