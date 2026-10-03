import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { request } from '@/lib/api';
import { formatDate, minorToAmount } from '@/lib/format';
import { Badge, Card, EmptyState, PageLoader, ProgressBar, StatCard, Td, Th, Tr } from '@/components/ui';
import { Table } from '@/components/ui';
import type {
  AnalyticsClientsResponse,
  AnalyticsEngagementResponse,
  AnalyticsPeriod,
  AnalyticsRevenueResponse,
  AnalyticsSummaryResponse,
  AnalyticsTestimonialsResponse,
} from '@/types/dashboard';

const PERIODS: { value: AnalyticsPeriod; label: string }[] = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '12m', label: '12 months' },
  { value: 'all', label: 'All time' },
];

export function AnalyticsPage() {
  const [period, setPeriod] = useState<AnalyticsPeriod>('30d');

  /* Four independent reads, issued in parallel by the query cache. The period is
   * in every key, so switching the window refetches all of them at once rather
   * than showing a mixture of ranges. */
  const summary = useQuery({
    queryKey: ['analytics', 'summary', period],
    queryFn: () => request<AnalyticsSummaryResponse>({ url: '/analytics/summary', params: { period } }),
  });
  const revenue = useQuery({
    queryKey: ['analytics', 'revenue', period],
    queryFn: () =>
      request<AnalyticsRevenueResponse>({ url: '/analytics/revenue', params: { period, groupBy: 'month' } }),
  });
  const engagement = useQuery({
    queryKey: ['analytics', 'engagement', period],
    queryFn: () => request<AnalyticsEngagementResponse>({ url: '/analytics/engagement', params: { period } }),
  });
  const testimonials = useQuery({
    /* Not windowed: a review has no date in the query, and `rangeSchema` would
     * be ignored anyway. */
    queryKey: ['analytics', 'testimonials'],
    queryFn: () => request<AnalyticsTestimonialsResponse>({ url: '/analytics/testimonials' }),
  });

  if (summary.isPending) return <PageLoader />;
  if (summary.isError) {
    return <EmptyState title="We could not load your analytics." hint="Try again in a moment." />;
  }

  const totals = summary.data;
  const series = revenue.data?.series ?? [];

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-display text-3xl font-semibold tracking-tight text-white">Analytics</h1>
          <p className="text-sm text-ink-400">How the studio is doing.</p>
        </div>
        <div role="tablist" className="flex flex-wrap gap-1 rounded-full border border-ink-700 p-1">
          {PERIODS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={period === option.value}
              onClick={() => setPeriod(option.value)}
              className={
                period === option.value
                  ? 'rounded-full bg-amber-400 px-3 py-1.5 text-sm font-medium text-ink-950'
                  : 'rounded-full px-3 py-1.5 text-sm text-ink-300 transition-colors hover:text-white'
              }
            >
              {option.label}
            </button>
          ))}
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Revenue received"
          value={minorToAmount(totals?.revenue.receivedMinor)}
          hint={`${totals?.revenue.transactions ?? 0} transactions`}
          tone="emerald"
        />
        <StatCard
          label="Outstanding"
          value={minorToAmount(totals?.revenue.outstandingMinor)}
          hint={`${totals?.revenue.outstandingInvoices ?? 0} invoices`}
          tone={(totals?.revenue.outstandingMinor ?? 0) > 0 ? 'amber' : 'neutral'}
        />
        <StatCard
          label="Booked value"
          value={minorToAmount(totals?.bookings.bookedMinor)}
          hint={`${totals?.bookings.total ?? 0} bookings`}
        />
        <StatCard
          label="Conversion"
          value={`${totals?.bookings.conversion ?? 0}%`}
          hint={`${totals?.clients ?? 0} clients, ${totals?.projects ?? 0} projects`}
        />
      </div>

      <Card className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-display text-lg font-semibold text-white">Revenue by month</h2>
          <span className="text-sm text-ink-400">
            Average {minorToAmount(revenue.data?.averageTransactionMinor)} per transaction
          </span>
        </div>
        {series.length === 0 ? (
          <p className="text-sm text-ink-400">No completed payments in this period.</p>
        ) : (
          /* Bars are scaled against the largest row rather than the total, so a
           * single big month does not flatten the rest into invisibility. */
          <div className="flex items-end gap-2" style={{ height: 180 }}>
            {series.map((row) => {
              const peak = Math.max(...series.map((entry) => entry.minor), 1);
              const height = Math.max(2, Math.round((row.minor / peak) * 100));
              return (
                <div key={row.period} className="flex flex-1 flex-col items-center justify-end gap-1">
                  <span className="text-[10px] text-ink-500">{row.period.slice(-2)}</span>
                  <div
                    className="w-full rounded-t bg-amber-400/80"
                    style={{ height: `${height}%` }}
                    title={`${row.period}: ${minorToAmount(row.minor)} across ${row.transactions} payments`}
                  />
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {engagement.data && (
        <section className="space-y-3">
          <h2 className="text-display text-xl font-semibold tracking-tight text-white">Gallery engagement</h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Photos uploaded" value={engagement.data.photosUploaded} />
            <StatCard label="Selections made" value={engagement.data.selectionsMade} tone="amber" />
            <StatCard label="Favourites given" value={engagement.data.favoritesGiven} />
            <StatCard label="Published galleries" value={engagement.data.publishedGalleries} tone="emerald" />
          </div>
          <Card className="space-y-3">
            <p className="text-sm text-ink-400">
              {engagement.data.averages.selectionsPerProject} selections per project,{' '}
              {engagement.data.averages.favoritesPerPhoto} favourites per photo.
            </p>
            {engagement.data.projects
              .filter((project) => project.publishedAt)
              .map((project) => (
                <div key={project.id} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-white">{project.title}</span>
                    <span className="text-ink-400">
                      {project.counts.selections} selected · {project.counts.favorites} favourited
                    </span>
                  </div>
                  {/* Scaled to the project's own photo count: a gallery with 20
                   * photos should not look identical to one with 400. */}
                  <ProgressBar value={project.counts.selections} max={Math.max(1, project.counts.photos)} />
                </div>
              ))}
          </Card>
        </section>
      )}

      {testimonials.data && testimonials.data.total > 0 && (
        <section className="space-y-3">
          <h2 className="text-display text-xl font-semibold tracking-tight text-white">Client reviews</h2>
          <Card className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="text-display text-3xl font-semibold text-white">
                {testimonials.data.average.toFixed(1)}
              </span>
              <div className="text-sm text-ink-400">
                <p>{testimonials.data.approved} approved</p>
                {testimonials.data.awaitingReview > 0 && (
                  <p>{testimonials.data.awaitingReview} awaiting review</p>
                )}
              </div>
            </div>
            {testimonials.data.distribution
              .filter((row) => row.count > 0)
              .map((row) => (
                <div key={row.star} className="flex items-center gap-3">
                  <span className="w-8 text-xs text-ink-400">{row.star} star</span>
                  <ProgressBar value={row.count} max={Math.max(1, testimonials.data!.approved)} />
                  <span className="w-6 text-right text-xs text-ink-400">{row.count}</span>
                </div>
              ))}
          </Card>
        </section>
      )}
    </div>
  );
}

/**
 * Engagement per client, sorted by spend.
 *
 * Split out from `AnalyticsPage` because the header does not need it: it is the
 * only analytics read that joins bookings to users, so a cold load can paint the
 * summary before this arrives.
 */
export function ClientEngagementTable() {
  const { data, isPending, isError } = useQuery({
    queryKey: ['analytics', 'clients'],
    queryFn: () => request<AnalyticsClientsResponse>({ url: '/analytics/clients' }),
  });

  if (isPending) return <PageLoader />;
  if (isError) return <EmptyState title="We could not load client engagement." />;

  const clients = data?.clients ?? [];
  if (clients.length === 0) return <EmptyState title="No client activity yet" />;

  return (
    <Table>
      <thead>
        <tr>
          <Th>Client</Th>
          <Th>Bookings</Th>
          <Th>Last shoot</Th>
          <Th className="text-right">Spent</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-ink-700">
        {clients.map((client) => (
          <Tr key={client.clientId}>
            <Td>
              <span className="text-white">{client.name}</span>
              {client.repeat && (
                <Badge tone="emerald" className="ml-2">
                  repeat
                </Badge>
              )}
            </Td>
            <Td className="text-ink-300">
              {client.bookings}
              {client.cancelled > 0 && (
                <span className="ml-1 text-xs text-ink-500">({client.cancelled} cancelled)</span>
              )}
            </Td>
            <Td className="text-ink-400">{formatDate(client.lastBookingAt)}</Td>
            <Td className="text-right text-white">{minorToAmount(client.spentMinor)}</Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}