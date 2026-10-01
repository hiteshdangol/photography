/**
 * Photography categories. Seeded into the `Category` collection so the admin
 * panel can rename, reorder, feature or disable them without a redeploy.
 */
export const DEFAULT_CATEGORIES = [
  { key: 'wedding', label: 'Wedding', sortOrder: 1, featured: true },
  { key: 'portrait', label: 'Portrait', sortOrder: 2, featured: true },
  { key: 'event', label: 'Event', sortOrder: 3, featured: true },
  { key: 'pre_wedding', label: 'Pre-wedding', sortOrder: 4, featured: true },
  { key: 'graduation', label: 'Graduation', sortOrder: 5, featured: true },
  { key: 'product', label: 'Product', sortOrder: 6, featured: true },
  { key: 'fashion', label: 'Fashion', sortOrder: 7, featured: true },
  { key: 'birthday', label: 'Birthday', sortOrder: 8, featured: false },
  { key: 'corporate', label: 'Corporate', sortOrder: 9, featured: true },
  { key: 'travel', label: 'Travel', sortOrder: 10, featured: false },
  { key: 'newborn', label: 'Newborn', sortOrder: 11, featured: true },
  { key: 'family', label: 'Family', sortOrder: 12, featured: true },
  { key: 'other', label: 'Other', sortOrder: 13, featured: false },
] as const;

export const CATEGORY_KEYS = DEFAULT_CATEGORIES.map((c) => c.key);

export const DEFAULT_CURRENCY_SYMBOLS: Record<string, string> = {
  NPR: 'NPR',
  USD: '$',
  EUR: '\u20ac',
  GBP: '\u00a3',
  INR: '\u20b9',
};
