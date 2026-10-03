import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { request } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { Badge, Card, EmptyState, PageLoader } from '@/components/ui';
import type { ProjectListResponse } from '@/types/dashboard';

/**
 * The client's own galleries.
 *
 * Backed by the same `/projects` endpoint as the photographer list: the server
 * scopes by the verified role, so a client receives only projects they booked.
 * There is deliberately no client-side filter — if a project came back it is
 * theirs to see.
 */
export function ClientGalleriesPage() {
  const { data, isPending, isError } = useQuery({
    queryKey: ['projects', 'client'],
    queryFn: () => request<ProjectListResponse>({ url: '/projects', params: { limit: 60 } }),
  });

  if (isPending) return <PageLoader />;
  if (isError) return <EmptyState title="We could not load your galleries." hint="Try again in a moment." />;

  const projects = data?.projects ?? [];
  /* Split on the one field that decides whether the gallery is worth opening:
   * `gallery.published` is set by the photographer, not by the client. */
  const live = projects.filter((project) => project.gallery.published);
  const pending = projects.filter((project) => !project.gallery.published);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-display text-3xl font-semibold tracking-tight text-white">Your galleries</h1>
        <p className="text-sm text-ink-400">
          Open a gallery to favourite photographs and build your selection.
        </p>
      </header>

      <Section title="Ready to browse" projects={live} emptyHint="Your photographer will publish your gallery once the editing is done." />

      {pending.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-display text-xl font-semibold tracking-tight text-white">
            Waiting on your photographer
          </h2>
          {pending.map((project) => (
            <Card key={project._id} className="flex flex-wrap items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="font-medium text-white">{project.title}</p>
                <p className="mt-1 text-sm text-ink-400">
                  {formatDate(project.eventDate)}
                  {project.location ? ` · ${project.location}` : ''}
                </p>
              </div>
              <Badge tone="neutral">{project.timelineStage.replace(/_/g, ' ')}</Badge>
            </Card>
          ))}
        </section>
      )}
    </div>
  );
}

function Section({
  title,
  projects,
  emptyHint,
}: {
  title: string;
  projects: ProjectListResponse['projects'];
  emptyHint: string;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-display text-xl font-semibold tracking-tight text-white">{title}</h2>
      {projects.length === 0 ? (
        <EmptyState title="Nothing here yet" hint={emptyHint} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {projects.map((project) => (
            <Card key={project._id} className="flex flex-col justify-between gap-4">
              <div>
                <p className="font-medium text-white">{project.title}</p>
                <p className="mt-1 text-sm text-ink-400">
                  {formatDate(project.eventDate)}
                  {project.location ? ` · ${project.location}` : ''}
                </p>
                <p className="mt-2 text-xs text-ink-500">
                  {project.counts.photos} photos · {project.counts.highlights} highlights
                </p>
              </div>
              <div className="flex items-center justify-between gap-3">
                {project.gallery.expiresAt ? (
                  <span className="text-xs text-ink-500">
                    Available until {formatDate(project.gallery.expiresAt)}
                  </span>
                ) : (
                  <span />
                )}
                <Link
                  to={`/projects/${project._id}`}
                  className="rounded-full bg-amber-400 px-4 py-2 text-sm font-medium text-ink-950 transition-colors hover:bg-amber-300"
                >
                  Open gallery
                </Link>
              </div>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}