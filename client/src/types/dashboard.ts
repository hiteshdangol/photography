/**
 * Read models for the photographer dashboard and the client's own space.
 *
 * These mirror the server's response shapes exactly rather than being derived
 * client-side, because several of these endpoints return `lean()` documents that
 * bypass schema virtuals: there is no `id`, only `_id`. `BookingsPage` had the
 * same subtlety and commented it inline.
 */

/** A populated `clientId` on the project list; a bare id for a client viewer. */
export type PopulatedClient =
  | string
  | { _id: string; name?: string; email?: string; phone?: string; avatar?: string }
  | null;

export type ProjectStatus =
  | 'planning'
  | 'confirmed'
  | 'shooting'
  | 'editing'
  | 'delivered'
  | 'completed'
  | 'cancelled';

export interface ProjectRow {
  /** `lean()` bypasses `virtuals: true`, so there is no `id`. */
  _id: string;
  title: string;
  slug: string;
  description?: string;
  eventDate: string;
  location: string;
  eventType: string;
  coverPhotoId: string | null;
  status: ProjectStatus;
  /** One of the 11 timeline stages, e.g. `gallery_published`. */
  timelineStage: string;
  timelineCompletedAt: string | null;
  gallery: {
    published: boolean;
    publishedAt: string | null;
    highlightsPublishedAt: string | null;
    highlightsCount: number;
    totalPhotos: number;
    allowClientDownloads: boolean;
    allowOriginalDownloads: boolean;
    deliveredAt: string | null;
    expiresAt: string | null;
  };
  counts: {
    photos: number;
    highlights: number;
    albums: number;
    selections: number;
    favorites: number;
  };
  totalMinor: number;
  currency: string;
  clientId: PopulatedClient;
  createdAt?: string;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ProjectListResponse {
  projects: ProjectRow[];
  pagination: Pagination;
  summary: { status: string; count: number; valueMinor: number }[];
}

export interface ProjectSummaryResponse {
  totals: { total: number; valueMinor: number; active: number; delivered: number };
  /** Keyed by timeline stage, not by status. */
  byStage: Record<string, number>;
  upcoming: {
    _id: string;
    title: string;
    eventDate: string;
    status: ProjectStatus;
    timelineStage: string;
    location: string;
  }[];
  /** Past the event date but not delivered: the studio's to-do list. */
  needsAttention: number;
}

/* -------------------------------------------------------------------------- */
/* Invoices                                                                     */
/* -------------------------------------------------------------------------- */

export type InvoiceStatus = 'unpaid' | 'partially_paid' | 'paid' | 'overdue' | 'void';

export interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  bookingId: string;
  projectId: string | null;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  paidMinor: number;
  remainingMinor: number;
  currency: string;
  status: InvoiceStatus;
  dueDate: string | null;
  paidAt: string | null;
  balanceDueMinor: number;
  hasPdf: boolean;
  pdfUrl: string;
  /** Derived server-side from the due date; do not recompute it locally. */
  overdue: boolean;
  viewerRole: 'photographer' | 'client' | 'admin';
  /** Only a photographer may still change an unpaid invoice. */
  editable: boolean;
  createdAt: string;
}

export interface InvoiceListResponse {
  invoices: InvoiceRow[];
  summary: { totalMinor: number; paidMinor: number; outstandingMinor: number };
  pagination: Pagination;
}

/* -------------------------------------------------------------------------- */
/* Analytics                                                                    */
/* -------------------------------------------------------------------------- */

export type AnalyticsPeriod = '7d' | '30d' | '90d' | '12m' | 'all';

export interface AnalyticsSummaryResponse {
  range: { from: string | null; to: string; days: number };
  bookings: { total: number; byStatus: Record<string, number>; bookedMinor: number; conversion: number };
  revenue: {
    receivedMinor: number;
    transactions: number;
    byCurrency: { _id: string; total: number }[];
    outstandingMinor: number;
    outstandingInvoices: number;
  };
  projects: number;
  clients: number;
}

export interface AnalyticsRevenueResponse {
  range: { from: string | null; to: string };
  groupBy: 'day' | 'week' | 'month';
  series: { period: string; minor: number; transactions: number; feesMinor: number }[];
  totalMinor: number;
  averageTransactionMinor: number;
}

export interface AnalyticsClientsResponse {
  clients: {
    clientId: string;
    name: string;
    email: string;
    phone: string;
    avatar: string;
    bookings: number;
    cancelled: number;
    spentMinor: number;
    lastBookingAt: string | null;
    /** More than one non-cancelled booking. */
    repeat: boolean;
  }[];
  range: { from: string | null; to: string };
}

export interface AnalyticsEngagementResponse {
  range: { from: string | null; to: string };
  photosUploaded: number;
  selectionsMade: number;
  favoritesGiven: number;
  albums: number;
  publishedGalleries: number;
  projects: {
    id: string;
    title: string;
    status: ProjectStatus;
    eventDate: string;
    publishedAt: string | null;
    counts: ProjectRow['counts'];
  }[];
  averages: { selectionsPerProject: number; favoritesPerPhoto: number };
}

export interface AnalyticsTestimonialsResponse {
  average: number;
  total: number;
  approved: number;
  awaitingReview: number;
  distribution: { star: number; count: number }[];
  recent: { id: string; rating: number; content: string; authorName: string; createdAt: string }[];
}

/* -------------------------------------------------------------------------- */
/* Portfolio                                                                    */
/* -------------------------------------------------------------------------- */

export interface PortfolioItemRow {
  id: string;
  title: string;
  description: string;
  category: string;
  width: number;
  height: number;
  aspectRatio: number;
  blurDataUrl: string | null;
  /** Already an API path; it is public, so it needs no credential. */
  thumbUrl: string;
  largeUrl: string;
  sortOrder: number;
  /** Only present on the authenticated management list. */
  published?: boolean;
  featured?: boolean;
  createdAt?: string;
}