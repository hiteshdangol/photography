import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { request, errorMessage } from '@/lib/api';
import { Badge, Button, Card, EmptyState, PageLoader, SectionHeading, StatCard } from '@/components/ui';
import type { PortfolioItemRow } from '@/types/dashboard';

const LIST_KEY = ['portfolio'] as const;

interface PortfolioListResponse {
  items: PortfolioItemRow[];
  total: number;
}

/**
 * The photographer's portfolio: the work shown on their public profile.
 *
 * Publishing is optimistic because it is the single most repeated action on this
 * screen, and waiting for a round trip per click makes a multi-select feel broken.
 * A failed toggle restores the exact previous state instead of refetching, which
 * would otherwise reset the image grid it is sitting on.
 */
export function PortfolioManagerPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<'all' | 'published' | 'drafts'>('all');

  const { data, isPending, isError } = useQuery({
    queryKey: LIST_KEY,
    queryFn: () => request<PortfolioListResponse>({ url: '/portfolio' }),
  });

  const toggle = useMutation({
    mutationFn: (input: { id: string; field: 'published' | 'featured'; value: boolean }) =>
      request<{ item: PortfolioItemRow }>({
        url: `/portfolio/${input.id}`,
        method: 'patch',
        data: { [input.field]: input.value },
      }),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: LIST_KEY });
      const previous = queryClient.getQueryData<PortfolioListResponse>(LIST_KEY);
      queryClient.setQueryData<PortfolioListResponse>(LIST_KEY, (old) =>
        old
          ? {
              ...old,
              items: old.items.map((item) =>
                item.id === input.id ? { ...item, [input.field]: input.value } : item,
              ),
            }
          : old,
      );
      return { previous };
    },
    onError: (error, input, context) => {
      if (context?.previous) queryClient.setQueryData(LIST_KEY, context.previous);
      toast.error(errorMessage(error, `We could not ${input.field === 'published' ? 'change publishing' : 'update featuring'}.`));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: LIST_KEY });
    },
  });

  const items = data?.items ?? [];
  const visible = items.filter((item) => {
    if (filter === 'published') return item.published === true;
    if (filter === 'drafts') return item.published !== true;
    return true;
  });
  const published = items.filter((item) => item.published === true).length;
  const featured = items.filter((item) => item.featured === true).length;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-display text-3xl font-semibold tracking-tight text-white">Portfolio</h1>
        <p className="text-sm text-ink-400">
          Images shown on your public profile. Only published items appear there.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Images" value={items.length} />
        <StatCard label="Published" value={published} tone="emerald" />
        <StatCard label="Featured" value={featured} tone="amber" />
      </div>

      <div role="tablist" className="flex flex-wrap gap-1 border-b border-ink-700">
        {(['all', 'published', 'drafts'] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={filter === option}
            onClick={() => setFilter(option)}
            className={
              filter === option
                ? 'border-b-2 border-amber-400 px-3 py-2 text-sm font-medium text-amber-400'
                : 'border-b-2 border-transparent px-3 py-2 text-sm text-ink-400 transition-colors hover:text-ink-200'
            }
          >
            {option === 'all' ? 'All' : option === 'published' ? 'Published' : 'Drafts'}
          </button>
        ))}
      </div>

      {isPending ? (
        <PageLoader />
      ) : isError ? (
        <EmptyState title="We could not load your portfolio." hint="Try again in a moment." />
      ) : visible.length === 0 ? (
        <EmptyState
          title={items.length === 0 ? 'No portfolio images yet' : 'Nothing in this filter'}
          hint={
            items.length === 0
              ? 'Upload work to fill out your public profile.'
              : 'Switch filters to see the rest of your work.'
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((item) => (
            <Card key={item.id} className="space-y-3">
              <img
                src={item.thumbUrl}
                alt={item.title}
                width={item.width}
                height={item.height}
                loading="lazy"
                className="aspect-4/3 w-full rounded-xl object-cover"
              />
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium text-white">{item.title}</p>
                  {item.featured && <Badge tone="amber">featured</Badge>}
                </div>
                {item.category && <p className="text-xs text-ink-500">{item.category}</p>}
              </div>
              <div className="flex gap-2">
                <Button
                  variant={item.published ? 'secondary' : 'primary'}
                  size="sm"
                  loading={toggle.isPending && toggle.variables?.id === item.id}
                  onClick={() =>
                    toggle.mutate({ id: item.id, field: 'published', value: !item.published })
                  }
                >
                  {item.published ? 'Unpublish' : 'Publish'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  loading={toggle.isPending && toggle.variables?.id === item.id}
                  onClick={() => toggle.mutate({ id: item.id, field: 'featured', value: !item.featured })}
                >
                  {item.featured ? 'Unfeature' : 'Feature'}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/** Kept for symmetry with the other management screens. */
export function PortfolioPlaceholder() {
  return (
    <SectionHeading
      title="Portfolio"
      hint="Upload and publish the images shown on your public profile."
    />
  );
}