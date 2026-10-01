import { useQuery } from '@tanstack/react-query';
import { request } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { Card, EmptyState, PageLoader } from '@/components/ui';

interface BookingRow {
  id: string;
  clientName: string;
  packageName: string;
  eventDate: string | null;
  status: string;
  totalMinor: number;
}

interface BookingsResponse {
  bookings: BookingRow[];
}

export function BookingsPage() {
  const { user } = useAuth();
  const isClient = user?.role === 'client';

  const { data, isPending } = useQuery({
    queryKey: ['bookings', isClient],
    queryFn: () => request<BookingsResponse>({ url: isClient ? '/bookings/mine' : '/bookings' }),
  });

  if (isPending) return <PageLoader />;

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
            <Card key={b.id} className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="font-medium text-white">{b.packageName}</p>
                <p className="text-sm text-ink-400">{isClient ? b.packageName : b.clientName}</p>
              </div>
              <div className="text-right">
                <p className="text-sm text-white">{(b.totalMinor / 100).toLocaleString()}</p>
                <p className="text-xs uppercase tracking-wide text-ink-400">{b.status}</p>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
