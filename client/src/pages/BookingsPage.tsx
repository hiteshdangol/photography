import { useQuery } from '@tanstack/react-query';
import { request } from '@/lib/api';
import { minorToAmount } from '@/lib/format';
import { useAuth } from '@/context/AuthContext';
import { Card, EmptyState, PageLoader } from '@/components/ui';

/** A populated `clientId`, as returned for photographers; a bare id for clients. */
type PopulatedClient = string | { _id: string; name?: string; email?: string } | null;

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
  clientId: PopulatedClient;
  priceSnapshot?: {
    packageName?: string;
    totalMinor?: number;
    currency?: string;
  };
}

interface BookingsResponse {
  bookings: BookingRow[];
}

function clientName(clientId: PopulatedClient): string {
  if (!clientId) return 'Client';
  if (typeof clientId === 'string') return 'Client';
  return clientId.name || clientId.email || 'Client';
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
  if (isError) return <EmptyState title="We could not load your bookings yet." hint="Try again in a moment." />;

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
        {rows.map((b) => (
          <Card key={b._id} className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="font-medium text-white">{b.priceSnapshot?.packageName || b.eventType}</p>
              <p className="text-sm text-ink-400">{isClient ? b.reference : clientName(b.clientId)}</p>
              {b.eventDate && (
                <p className="text-xs text-ink-400">
                  {new Date(b.eventDate).toLocaleDateString()} · {b.startTime}–{b.endTime}
                </p>
              )}
            </div>
            <div className="text-right">
              <p className="text-sm text-white">{minorToAmount(b.priceSnapshot?.totalMinor)}</p>
              <p className="text-xs uppercase tracking-wide text-ink-400">{b.status}</p>
            </div>
          </Card>
        ))}
        </div>
      )}
    </div>
  );
}
