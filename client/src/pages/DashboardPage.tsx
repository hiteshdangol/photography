import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { request } from '@/lib/api';
import { formatDate, minorToAmount } from '@/lib/format';
import { Avatar, Badge, Card, EmptyState, PageLoader, SectionHeading } from '@/components/ui';

/** Mirrors the payload of `GET /analytics/summary`. */
interface DashboardSummary {
  range?: { from: string | null; to: string | null; days: number };
  bookings?: {
    total: number;
    byStatus?: Record<string, number>;
    bookedMinor: number;
    conversion: number;
  };
  revenue?: {
    receivedMinor: number;
    transactions: number;
    outstandingMinor: number;
    outstandingInvoices: number;
  };
  projects?: number;
  clients?: number;
}

type PopulatedParty = string | { _id: string; name?: string; avatar?: string } | null;

interface UpcomingBooking {
  _id: string;
  reference: string;
  eventType: string;
  eventDate: string | null;
  startTime: string;
  location: string;
  status: string;
  clientId: PopulatedParty;
  priceSnapshot?: { packageName?: string; totalMinor?: number };
}

interface BookingsResponse {
  bookings: UpcomingBooking[];
}

function partyName(party: PopulatedParty): string {
  if (!party || typeof party === 'string') return 'Client';
  return party.name?.trim() || 'Client';
}

export function DashboardPage() {
  // `period=all` because this is a lifetime overview; the endpoint defaults to 30d.
  const { data, isPending, isError } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => request<DashboardSummary>({ url: '/analytics/summary', params: { period: 'all' } }),
  });

  /* What is actually shooting next. The three totals above are lifetime figures
   * and cannot answer "what have I got to do this week" - which is the only
   * reason to open a dashboard. `from` is sent as now so the server, not the
   * browser, decides what counts as upcoming. */
  const upcoming = useQuery({
    queryKey: ['dashboard', 'upcoming'],
    queryFn: () =>
      request<BookingsResponse>({
        url: '/bookings',
        params: { from: new Date().toISOString(), limit: 5 },
      }),
  });

  if (isPending) return <PageLoader />;
  if (isError) return <EmptyState title="We could not load your overview yet." hint="Try again in a moment." />;

  const rows = upcoming.data?.bookings ?? [];

  return (
    <div className="space-y-8">
      <h1 className="text-display text-3xl font-semibold tracking-tight">Overview</h1>
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <p className="text-xs uppercase tracking-wide text-ink-400">Projects</p>
          <p className="mt-2 text-3xl font-semibold text-white">{data?.projects ?? 0}</p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-ink-400">Bookings</p>
          <p className="mt-2 text-3xl font-semibold text-white">{data?.bookings?.total ?? 0}</p>
          <p className="mt-1 text-xs text-ink-400">{data?.bookings?.conversion ?? 0}% approved</p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-ink-400">Revenue received</p>
          <p className="mt-2 text-3xl font-semibold text-white">
            {minorToAmount(data?.revenue?.receivedMinor)}
          </p>
          <p className="mt-1 text-xs text-ink-400">
            {minorToAmount(data?.revenue?.outstandingMinor)} outstanding
          </p>
        </Card>
      </div>

      <section className="space-y-3">
        <SectionHeading
          title="Upcoming shoots"
          action={
            <Link to="/dashboard/bookings" className="text-sm font-medium text-amber-400 hover:text-amber-300">
              All bookings
            </Link>
          }
        />
        {upcoming.isError ? (
          <EmptyState title="We could not load upcoming shoots." hint="Try again in a moment." />
        ) : rows.length === 0 ? (
          <EmptyState title="Nothing scheduled" hint="Approved bookings appear here as they come in." />
        ) : (
          <div className="space-y-3">
            {rows.map((booking) => (
              <Card key={booking._id} className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar name={partyName(booking.clientId)} size={36} />
                  <div className="min-w-0">
                    {/* Package leads, as it does on the bookings page: the
                     * photographer needs to know what was sold, not just who. */}
                    <p className="font-medium text-white">
                      {booking.priceSnapshot?.packageName?.trim() || booking.eventType}
                    </p>
                    <p className="text-sm text-ink-400">
                      {partyName(booking.clientId)}
                      {booking.location ? ` · ${booking.location}` : ''}
                    </p>
                    {booking.eventDate && (
                      <p className="text-xs text-ink-500">
                        {formatDate(booking.eventDate)} · {booking.startTime}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3 text-right">
                  <span className="text-sm text-ink-300">
                    {minorToAmount(booking.priceSnapshot?.totalMinor)}
                  </span>
                  <Badge tone={booking.status === 'approved' ? 'emerald' : 'amber'}>{booking.status}</Badge>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
