import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { request } from '@/lib/api';
import { formatDate, minorToAmount } from '@/lib/format';
import { Badge, Card, EmptyState, Pagination, PageLoader, StatCard, toneForStatus } from '@/components/ui';
import type { Pagination as PaginationModel, ProjectListResponse, ProjectStatus, ProjectSummaryResponse } from '@/types/dashboard';

const PAGE_SIZE = 24;

/** Kept in the server's `PROJECT_STATUSES` order so the filter reads left to right. */
const FILTERS: { value: ProjectStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'planning', label: 'Planning' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'shooting', label: 'Shooting' },
  { value: 'editing', label: 'Editing' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

export function ProjectsListPage() {
  const [status, setStatus] = useState<ProjectStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const summary = useQuery({
    queryKey: ['project-summary'],
    queryFn: () => request<ProjectSummaryResponse>({ url: '/projects/summary' }),
  });

  const list = useQuery({
    // `page` is part of the key on purpose: paging must refetch, not re-render a
    // cached slice, otherwise the list silently repeats the first page.
    queryKey: ['projects', status, search, page],
    queryFn: () =>
      request<ProjectListResponse>({
        url: '/projects',
        params: {
          ...(status !== 'all' ? { status } : {}),
          ...(search.trim() ? { search: search.trim() } : {}),
          page,
          limit: PAGE_SIZE,
        },
      }),
  });

  function applyFilter(next: ProjectStatus | 'all') {
    setStatus(next);
    /* Changing the filter while on page 3 would show an empty page, so page 1 is
     * always the right destination. */
    setPage(1);
  }

  const totals = summary.data?.totals;
  const projects = list.data?.projects ?? [];
  const pagination = list.data?.pagination;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-display text-3xl font-semibold tracking-tight text-white">Projects</h1>
          <p className="text-sm text-ink-400">Every shoot, from booking request to delivery.</p>
        </div>
        <Link
          to="/dashboard/bookings"
          className="text-sm font-medium text-amber-400 transition-colors hover:text-amber-300"
        >
          Booking requests
        </Link>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total projects" value={totals?.total ?? 0} />
        <StatCard label="In progress" value={totals?.active ?? 0} tone="amber" />
        <StatCard label="Delivered" value={totals?.delivered ?? 0} tone="emerald" />
        {/* `needsAttention` is past the event date but undelivered: the work that
         * has quietly gone stale is the reason this number exists. */}
        <StatCard
          label="Needs attention"
          value={summary.data?.needsAttention ?? 0}
          tone={(summary.data?.needsAttention ?? 0) > 0 ? 'rose' : 'neutral'}
          hint="Past the event date, not delivered"
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" className="flex flex-wrap gap-1 border-b border-ink-700">
          {FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              role="tab"
              aria-selected={status === filter.value}
              onClick={() => applyFilter(filter.value)}
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
        <input
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
          placeholder="Search titles"
          aria-label="Search projects by title"
          className="h-10 w-full max-w-xs rounded-xl border border-ink-700 bg-ink-900 px-3 text-sm text-white placeholder:text-ink-500 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-400/20"
        />
      </div>

      {list.isPending ? (
        <PageLoader />
      ) : list.isError ? (
        <EmptyState title="We could not load your projects." hint="Check your connection and try again." />
      ) : projects.length === 0 ? (
        <EmptyState
          title="No projects match"
          hint={search ? 'Try a different search or filter.' : 'Approved bookings become projects automatically.'}
        />
      ) : (
        <div className="space-y-3">
          {projects.map((project) => (
            <Card key={project._id} className="flex flex-wrap items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to={`/dashboard/projects/${project._id}`}
                    className="font-medium text-white transition-colors hover:text-amber-400"
                  >
                    {project.title}
                  </Link>
                  <Badge tone={toneForStatus(project.status)}>{project.status.replace(/_/g, ' ')}</Badge>
                  {project.gallery.published && <Badge tone="emerald">gallery live</Badge>}
                </div>
                <p className="mt-1 text-sm text-ink-400">
                  {formatDate(project.eventDate)}
                  {project.location ? ` · ${project.location}` : ''}
                  {project.eventType ? ` · ${project.eventType}` : ''}
                </p>
                {/* Counts are denormalised on the project, so this row needs no
                 * extra request to tell a photographer what exists. */}
                <p className="mt-1 text-xs text-ink-500">
                  {project.counts.photos} photos · {project.counts.albums} albums ·{' '}
                  {project.counts.selections} selected
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm text-white">{minorToAmount(project.totalMinor)}</p>
                <p className="text-xs uppercase tracking-wide text-ink-500">
                  {project.timelineStage.replace(/_/g, ' ')}
                </p>
              </div>
            </Card>
          ))}
        </div>
      )}

      {pagination && pagination.totalPages > 1 && (
        <Pagination
          page={pagination.page}
          totalPages={pagination.totalPages}
          total={pagination.total}
          limit={pagination.limit}
          onChange={setPage}
        />
      )}
    </div>
  );
}

/** Re-exported so tests can assert the page size without importing the module twice. */
export const PROJECTS_PAGE_SIZE: PaginationModel['limit'] = PAGE_SIZE;