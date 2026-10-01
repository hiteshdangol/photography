/**
 * Formats a minor-unit amount (cents, paise) as a decimal string.
 *
 * Both the server's `*Minor` fields and the client's package price are minor
 * units, so dividing by 100 is the only correct conversion. Kept in one place
 * because `DashboardPage` and `BookingsPage` previously each had their own
 * version with different rounding.
 */
export function minorToAmount(value: number | undefined | null, fractionDigits = 2): string {
  return ((value ?? 0) / 100).toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

/** Bytes as a human-readable size. Binary units, so 1024-based. */
export function formatBytes(bytes: number | undefined | null): string {
  const value = bytes ?? 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[unit]}`;
}

/** ISO date to a short readable form; invalid input returns an em dash. */
export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
