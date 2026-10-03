import { useQuery } from '@tanstack/react-query';
import { request } from '@/lib/api';
import { formatDate, minorToAmount } from '@/lib/format';
import { Badge, Card, EmptyState, PageLoader, StatCard } from '@/components/ui';
import type { InvoiceListResponse, InvoiceRow } from '@/types/dashboard';

/**
 * What a client owes.
 *
 * Same endpoint and DTO as the photographer's ledger, scoped by the server to
 * the caller's own invoices, but the framing is inverted: the client wants "what
 * do I still need to pay", so outstanding invoices lead and settled ones trail.
 */
export function BillingPage() {
  const { data, isPending, isError } = useQuery({
    queryKey: ['invoices', 'client'],
    queryFn: () => request<InvoiceListResponse>({ url: '/invoices', params: { limit: 100 } }),
  });

  if (isPending) return <PageLoader />;
  if (isError) return <EmptyState title="We could not load your billing details." hint="Try again in a moment." />;

  const invoices = data?.invoices ?? [];
  const summary = data?.summary;

  /* An invoice is "settled" when nothing is left owing. A void invoice has no
   * balance at all, so it is filtered out rather than shown as paid. */
  const due = invoices
    .filter((invoice) => invoice.status !== 'void' && invoice.remainingMinor > 0)
    .sort((a, b) => {
      const aDate = a.dueDate ? new Date(a.dueDate).getTime() : Number.POSITIVE_INFINITY;
      const bDate = b.dueDate ? new Date(b.dueDate).getTime() : Number.POSITIVE_INFINITY;
      return aDate - bDate;
    });
  const settled = invoices.filter(
    (invoice) => invoice.status !== 'void' && invoice.remainingMinor <= 0,
  );

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-display text-3xl font-semibold tracking-tight text-white">Billing</h1>
        <p className="text-sm text-ink-400">Invoices from your photographer.</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Billed" value={minorToAmount(summary?.totalMinor)} />
        <StatCard label="Paid" value={minorToAmount(summary?.paidMinor)} tone="emerald" />
        <StatCard
          label="Balance due"
          value={minorToAmount(summary?.outstandingMinor)}
          tone={(summary?.outstandingMinor ?? 0) > 0 ? 'amber' : 'neutral'}
        />
      </div>

      <section className="space-y-3">
        <h2 className="text-display text-xl font-semibold tracking-tight text-white">Awaiting payment</h2>
        {due.length === 0 ? (
          <EmptyState title="Nothing to pay" hint="You are all settled up." />
        ) : (
          <div className="space-y-3">
            {due.map((invoice) => (
              <DueCard key={invoice.id} invoice={invoice} />
            ))}
          </div>
        )}
      </section>

      {settled.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-display text-xl font-semibold tracking-tight text-white">Paid</h2>
          <div className="space-y-3">
            {settled.map((invoice) => (
              <Card key={invoice.id} className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-white">{invoice.invoiceNumber}</p>
                  <p className="text-xs text-ink-400">
                    {invoice.paidAt ? `Paid ${formatDate(invoice.paidAt)}` : 'Settled'}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-ink-300">{minorToAmount(invoice.totalMinor)}</span>
                  <Badge tone="emerald">paid</Badge>
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
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function DueCard({ invoice }: { invoice: InvoiceRow }) {
  return (
    <Card className="flex flex-wrap items-center justify-between gap-4">
      <div>
        <div className="flex items-center gap-2">
          <p className="font-medium text-white">{invoice.invoiceNumber}</p>
          {invoice.overdue && <Badge tone="rose">overdue</Badge>}
        </div>
        <p className="mt-1 text-sm text-ink-400">
          {invoice.dueDate ? `Due ${formatDate(invoice.dueDate)}` : 'No due date'}
        </p>
        {/* A part-paid invoice shows both figures: the total alone hides that
         * something has already been settled. */}
        {invoice.paidMinor > 0 && (
          <p className="mt-1 text-xs text-ink-500">
            {minorToAmount(invoice.paidMinor)} of {minorToAmount(invoice.totalMinor)} paid
          </p>
        )}
      </div>
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-white">{minorToAmount(invoice.remainingMinor)}</span>
        {invoice.hasPdf && (
          <a
            href={invoice.pdfUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded-full border border-amber-400/40 px-4 py-2 text-sm font-medium text-amber-400 transition-colors hover:bg-amber-400/10"
          >
            View invoice
          </a>
        )}
      </div>
    </Card>
  );
}