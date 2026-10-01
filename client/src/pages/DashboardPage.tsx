import { useQuery } from '@tanstack/react-query';
import { request } from '@/lib/api';
import { minorToAmount } from '@/lib/format';
import { Card, EmptyState, PageLoader } from '@/components/ui';

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

export function DashboardPage() {
  // `period=all` because this is a lifetime overview; the endpoint defaults to 30d.
  const { data, isPending, isError } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => request<DashboardSummary>({ url: '/analytics/summary', params: { period: 'all' } }),
  });

  if (isPending) return <PageLoader />;
  if (isError) return <EmptyState title="We could not load your overview yet." hint="Try again in a moment." />;

  return (
    <div className="space-y-6">
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
    </div>
  );
}
