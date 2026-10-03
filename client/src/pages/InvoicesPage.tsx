import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { request } from '@/lib/api';
import { formatDate, minorToAmount } from '@/lib/format';
import { Badge, Card, EmptyState, PageLoader, StatCard, Td, Th, Tr, toneForStatus } from '@/components/ui';
import { Table } from '@/components/ui';
import type { InvoiceListResponse, InvoiceStatus } from '@/types/dashboard';

const FILTERS: { value: InvoiceStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'partially_paid', label: 'Part paid' },
  { value: 'paid', label: 'Paid' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'void', label: 'Void' },
];

export function InvoicesPage() {
  const [status, setStatus] = useState<InvoiceStatus | 'all'>('all');
  const [page, setPage] = useState(1);

  const { data, isPending, isError } = useQuery({
    queryKey: ['invoices', status, page],
    queryFn: () =>
      request<InvoiceListResponse>({
        url: '/invoices',
        params: { ...(status !== 'all' ? { status } : {}), page, limit: 25 },
      }),
  });

  const invoices = data?.invoices ?? [];
  const summary = data?.summary;
  const pagination = data?.pagination;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-display text-3xl font-semibold tracking-tight text-white">Invoices</h1>
        <p className="text-sm text-ink-400">Every invoice raised against your bookings.</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Billed" value={minorToAmount(summary?.totalMinor)} />
        <StatCard label="Received" value={minorToAmount(summary?.paidMinor)} tone="emerald" />
        <StatCard
          label="Outstanding"
          value={minorToAmount(summary?.outstandingMinor)}
          tone={(summary?.outstandingMinor ?? 0) > 0 ? 'amber' : 'neutral'}
        />
      </div>

      <div role="tablist" className="flex flex-wrap gap-1 border-b border-ink-700">
        {FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            role="tab"
            aria-selected={status === filter.value}
            onClick={() => {
              setStatus(filter.value);
              setPage(1);
            }}
            className={
              status === filter.value
                ? 'border-b-2 border-amber-400 px-3 py-2 text-sm font-medium text-amber-400'
                : 'border-b-2 border-transparent px-3 py-2 text-sm text-ink-400 transition-colors hover:text-ink-200'
            }
          >
            {filter.label}
          </button>
        ))}
      </div>

      {isPending ? (
        <PageLoader />
      ) : isError ? (
        <EmptyState title="We could not load your invoices." hint="Try again in a moment." />
      ) : invoices.length === 0 ? (
        <EmptyState title="No invoices" hint="Invoices appear here once a booking is invoiced." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Invoice</Th>
              <Th>Project</Th>
              <Th>Status</Th>
              <Th>Due</Th>
              <Th className="text-right">Total</Th>
              <Th className="text-right">Outstanding</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-700">
            {invoices.map((invoice) => (
              <Tr key={invoice.id}>
                <Td className="font-medium text-white">{invoice.invoiceNumber}</Td>
                <Td>
                  {invoice.projectId ? (
                    <Link to={`/dashboard/projects/${invoice.projectId}`} className="hover:text-amber-400">
                      Project
                    </Link>
                  ) : (
                    <span className="text-ink-500">—</span>
                  )}
                </Td>
                <Td>
                  {/* `overdue` is computed server-side from the due date, so an
                   * invoice marked `unpaid` but past due still reads as overdue. */}
                  <Badge tone={invoice.overdue ? 'rose' : toneForStatus(invoice.status)}>
                    {invoice.overdue && invoice.status !== 'paid' ? 'overdue' : invoice.status.replace(/_/g, ' ')}
                  </Badge>
                </Td>
                <Td className="text-ink-400">{formatDate(invoice.dueDate)}</Td>
                <Td className="text-right text-white">{minorToAmount(invoice.totalMinor)}</Td>
                <Td className="text-right text-ink-300">{minorToAmount(invoice.remainingMinor)}</Td>
                <Td className="text-right">
                  {invoice.hasPdf && (
                    <a
                      href={invoice.pdfUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm text-amber-400 hover:text-amber-300"
                    >
                      PDF
                    </a>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}

      {pagination && pagination.totalPages > 1 && (
        <div className="flex justify-center">
          <PageLink page={pagination.page} totalPages={pagination.totalPages} onChange={setPage} />
        </div>
      )}
    </div>
  );
}

function PageLink({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (n: number) => void }) {
  return (
    <Card className="flex items-center gap-3">
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
        className="text-sm text-ink-300 disabled:opacity-40"
      >
        Previous
      </button>
      <span className="text-sm text-ink-400">
        {page} / {totalPages}
      </span>
      <button
        type="button"
        disabled={page >= totalPages}
        onClick={() => onChange(page + 1)}
        className="text-sm text-ink-300 disabled:opacity-40"
      >
        Next
      </button>
    </Card>
  );
}