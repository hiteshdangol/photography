import { useQuery } from '@tanstack/react-query';
import { request } from '@/lib/api';
import { minorToAmount } from '@/lib/format';
import { useAuth } from '@/context/AuthContext';
import { Card, EmptyState, PageLoader } from '@/components/ui';

/**
 * A populated party reference, as returned by `/bookings`: a document for the
 * side the caller can already see, or a bare id if the populate was skipped.
 */
type PopulatedParty = string | { _id: string; name?: string; avatar?: string } | null;

interface BookingRow {
  /** `lean()` bypasses the schema's `virtuals: true`, so there is no `id`. */
  _id: string;
  reference: string;
  eventType: string;
  eventDate: string | null;
  startTime: string;
  endTime: string;
  location: string;
  status: string;
  paymentStatus: string;
  clientId: PopulatedParty;
  /** Populated by the server since the booking-list fix; a bare id otherwise. */
  photographerId: PopulatedParty;
  priceSnapshot?: {
    packageName?: string;
    totalMinor?: number;
    currency?: string;
    depositMinor?: number;
  };
}

interface BookingsResponse {
  bookings: BookingRow[];
}

function partyName(party: PopulatedParty, fallback: string): string {
  if (!party) return fallback;
  if (typeof party === 'string') return fallback;
  return party.name?.trim() || fallback;
}

export function BookingsPage() {
  const { user } = useAuth();
  const isClient = user?.role === 'client';

  // One endpoint for both roles: the server scopes the list by the verified role.
  const { data, isPending, isError } = useQuery({
    queryKey: ['bookings', isClient],
    queryFn: () => request<BookingsResponse>({ url: '/bookings' }),
  });

  if (isPending) return <PageLoader />;
  if (isError) return <EmptyState title="We could not load your bookings yet." hint="Try again in a moment." />

  const rows = data?.bookings ?? [];

  return (
    <div className="space-y-6">
      <h1 className="text-display text-3xl font-semibold tracking-tight">
        {isClient ? 'My bookings' : 'Bookings'}
      </h1>
      {rows.length === 0 ? (
        <EmptyState title="Nothing here yet" hint={isClient ? 'Your bookings will appear here.' : 'New requests will appear here.'} />
      ) : (
        <div className="space-y-3">
        {rows.map((b) => {
          /* The package is the headline: a client asked for a specific package,
           * and falling back to `eventType` alone lost what they booked. */
          const packageName = b.priceSnapshot?.packageName?.trim();
          return (
          <Card key={b._id} className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="font-medium text-white">{packageName || b.eventType}</p>
              {/* Both parties, each labelled from the viewer's perspective: a
               * client needs to know who is shooting, a photographer needs to know
               * who booked. */}
              <p className="text-sm text-ink-400">
                {isClient
                  ? partyName(b.photographerId, 'Your photographer')
                  : partyName(b.clientId, 'Client')}
                <span className="text-ink-600"> · </span>
                <span className="text-ink-500">{b.reference}</span>
              </p>
              <p className="mt-1 text-xs text-ink-400">
                {b.eventType}
                {b.location ? ` · ${b.location}` : ''}
              </p>
              {b.eventDate && (
                <p className="text-xs text-ink-400">
                  {new Date(b.eventDate).toLocaleDateString()} · {b.startTime}–{b.endTime}
                </p>
              )}
            </div>
            <div className="text-right">
              <p className="text-sm text-white">{minorToAmount(b.priceSnapshot?.totalMinor)}</p>
              <p className="text-xs uppercase tracking-wide text-ink-400">{b.status}</p>
              {(b.priceSnapshot?.depositMinor ?? 0) > 0 && (
                <p className="text-xs text-ink-500">
                  {minorToAmount(b.priceSnapshot?.depositMinor)} deposit
                </p>
              )}
            </div>
          </Card>
          );
        })}
        </div>
      )}
    </div>
  );
}
