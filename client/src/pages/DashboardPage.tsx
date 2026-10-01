import { useQuery } from '@tanstack/react-query';
import { request } from '@/lib/api';
import { Card, EmptyState, PageLoader } from '@/components/ui';

interface DashboardSummary {
  projects?: { total: number; active: number };
  bookings?: { total: number; pending: number };
  revenue?: { totalMinor: number };
}

export function DashboardPage() {
  const { data, isPending, isError } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => request<DashboardSummary>({ url: '/analytics/overview' }),
  });

  if (isPending) return <PageLoader />;
  if (isError) return <EmptyState title="We could not load your overview yet." hint="Try again in a moment." />;

  return (
    <div className="space-y-6">
      <h1 className="text-display text-3xl font-semibold tracking-tight">Overview</h1>
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <p className="text-xs uppercase tracking-wide text-ink-400">Projects</p>
          <p className="mt-2 text-3xl font-semibold text-white">{data?.projects?.total ?? 0}</p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-ink-400">Bookings</p>
          <p className="mt-2 text-3xl font-semibold text-white">{data?.bookings?.total ?? 0}</p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-ink-400">Revenue</p>
          <p className="mt-2 text-3xl font-semibold text-white">
            {((data?.revenue?.totalMinor ?? 0) / 100).toLocaleString()}
          </p>
        </Card>
      </div>
    </div>
  );
}
