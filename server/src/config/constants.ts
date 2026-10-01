export const USER_ROLES = ['superadmin', 'photographer', 'client'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ['active', 'suspended', 'pending_verification'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const BOOKING_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'completed',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const PAYMENT_STATUSES = [
  'unpaid',
  'deposit_pending',
  'partially_paid',
  'paid',
  'overdue',
  'refund_pending',
  'refunded',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PROJECT_STATUSES = [
  'planning',
  'confirmed',
  'shooting',
  'editing',
  'delivered',
  'completed',
  'cancelled',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const ALBUM_STATUSES = ['draft', 'selection_open', 'selection_complete', 'final'] as const;
export type AlbumStatus = (typeof ALBUM_STATUSES)[number];

export const PAYMENT_PROVIDERS = ['mock', 'esewa', 'khalti', 'manual'] as const;
export type PaymentProviderName = (typeof PAYMENT_PROVIDERS)[number];

export const PAYMENT_TYPES = ['deposit', 'balance', 'full', 'adjustment', 'refund'] as const;
export type PaymentType = (typeof PAYMENT_TYPES)[number];

export const TRANSACTION_STATUSES = [
  'created',
  'pending',
  'completed',
  'failed',
  'expired',
  'refunded',
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const INVOICE_STATUSES = ['unpaid', 'partially_paid', 'paid', 'overdue', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const NOTIFICATION_TYPES = [
  'booking_requested',
  'booking_approved',
  'booking_rejected',
  'booking_cancelled',
  'booking_reminder',
  'payment_due',
  'payment_successful',
  'payment_failed',
  'payment_reminder',
  'refund_pending',
  'refund_completed',
  'timeline_updated',
  'session_completed',
  'highlights_published',
  'gallery_published',
  'gallery_link_expiring',
  'selection_completed',
  'album_published',
  'invoice_issued',
  'payment_received',
  'comment_added',
  'new_message',
  'testimonial_requested',
  'testimonial_submitted',
  'system',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const PHOTO_CATEGORIES = [
  'highlights',
  'ceremony',
  'reception',
  'portraits',
  'family',
  'candid',
  'pre_wedding',
  'details',
  'other',
] as const;
export type PhotoCategory = (typeof PHOTO_CATEGORIES)[number];

export const STORAGE_KEYS = [
  'originals',
  'optimized',
  'thumbnails',
  'portfolio',
  'avatars',
  'invoices',
  'mail',
  'tmp',
] as const;
export type StorageKey = (typeof STORAGE_KEYS)[number];

export const COOKIE_NAMES = {
  refresh: 'lf_rt',
  csrf: 'lf_csrf',
} as const;

export const AUTH_ERRORS = {
  unauthenticated: 'You must be signed in to do that.',
  forbidden: 'You are not authorized to perform this action.',
  crossTenant: 'You are not authorized to access this resource.',
} as const;
