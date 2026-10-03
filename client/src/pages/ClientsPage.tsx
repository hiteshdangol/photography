import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { request } from '@/lib/api';
import { formatDate, minorToAmount } from '@/lib/format';
import { Avatar, Badge, Card, EmptyState, PageLoader, StatCard } from '@/components/ui';
import { Table, Td, Th, Tr } from '@/components/ui';
import type { AnalyticsClientsResponse } from '@/types/dashboard';

/**
 * The studio's client list.
 *
 * Reads `/analytics/clients` rather than a client directory because the useful
 * unit here is the *relationship* — shoots booked, money spent, whether they came
 * back — not the account. That aggregation only exists on the analytics side.
 */
export function ClientsPage() {
  const [search, setSearch] = useState('');
  const [showRepeatOnly, setShowRepeatOnly] = useState(false);

  const { data, isPending, isError } = useQuery({
    queryKey: ['analytics', 'clients'],
    queryFn: () => request<AnalyticsClientsResponse>({ url: '/analytics/clients', params: { limit: 100 } }),
  });

  const all = data?.clients ?? [];
  const needle = search.trim().toLowerCase();
  const clients = all.filter((client) => {
    if (showRepeatOnly && !client.repeat) return false;
    if (!needle) return true;
    return client.name.toLowerCase().includes(needle) || client.email.toLowerCase().includes(needle);
  });

  const totalSpent = all.reduce((sum, client) => sum + client.spentMinor, 0);
  const repeatCount = all.filter((client) => client.repeat).length;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-display text-3xl font-semibold tracking-tight text-white">Clients</h1>
        <p className="text-sm text-ink-400">Everyone who has booked you.</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Clients" value={all.length} />
        <StatCard label="Repeat" value={repeatCount} tone="emerald" hint="More than one shoot" />
        <StatCard label="Lifetime value" value={minorToAmount(totalSpent)} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search name or email"
          aria-label="Search clients"
          className="h-10 w-full max-w-xs rounded-xl border border-ink-700 bg-ink-900 px-3 text-sm text-white placeholder:text-ink-500 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-400/20"
        />
        <label className="flex items-center gap-2 text-sm text-ink-300">
          <input
            type="checkbox"
            checked={showRepeatOnly}
            onChange={(event) => setShowRepeatOnly(event.target.checked)}
            className="h-4 w-4 rounded border-ink-600 bg-ink-900 accent-amber-400"
          />
          Repeat clients only
        </label>
      </div>

      {isPending ? (
        <PageLoader />
      ) : isError ? (
        <EmptyState title="We could not load your clients." hint="Try again in a moment." />
      ) : clients.length === 0 ? (
        <EmptyState
          title={all.length === 0 ? 'No clients yet' : 'No clients match'}
          hint={all.length === 0 ? 'Approved bookings create a client relationship here.' : 'Try a different search.'}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Client</Th>
              <Th>Contact</Th>
              <Th>Bookings</Th>
              <Th>Last shoot</Th>
              <Th className="text-right">Spent</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-700">
            {clients.map((client) => (
              <Tr key={client.clientId}>
                <Td>
                  <div className="flex items-center gap-3">
                    <Avatar name={client.name} src={client.avatar || undefined} size={32} />
                    <div>
                      <p className="text-white">{client.name}</p>
                      {client.repeat && <Badge tone="emerald">repeat</Badge>}
                    </div>
                  </div>
                </Td>
                <Td className="text-ink-400">
                  <p>{client.email || '—'}</p>
                  {client.phone && <p className="text-xs text-ink-500">{client.phone}</p>}
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
      )}

      {/* Shown only when a filter is hiding rows, so the user knows the list they
       * see is not the whole list. */}
      {all.length > clients.length && (
        <Card>
          <p className="text-sm text-ink-400">
            Showing {clients.length} of {all.length} clients.
          </p>
        </Card>
      )}
    </div>
  );
}