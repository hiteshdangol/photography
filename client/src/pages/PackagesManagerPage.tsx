import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from '@/lib/api';
import { Button, Card, EmptyState, Input, PageLoader } from '@/components/ui';

interface PackageRow {
  id: string;
  name: string;
  description: string;
  price: number;
  active: boolean;
}

interface PackagesResponse {
  packages: PackageRow[];
}

export function PackagesManagerPage() {
  const queryClient = useQueryClient();

  const { data, isPending } = useQuery({
    queryKey: ['packages', 'mine'],
    queryFn: () => request<PackagesResponse>({ url: '/packages/mine' }),
  });

  const create = useMutation({
    mutationFn: (body: { name: string; price: number }) =>
      request<unknown>({ url: '/packages', method: 'POST', data: body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['packages'] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => request<unknown>({ url: `/packages/${id}`, method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['packages'] }),
  });

  if (isPending) return <PageLoader />;

  const rows = data?.packages ?? [];

  return (
    <div className="space-y-6">
      <h1 className="text-display text-3xl font-semibold tracking-tight">Packages</h1>

      <Card className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1">
          <Input id="pkg-name" label="Name" placeholder="Signature session" />
        </div>
        <div className="w-40">
          <Input id="pkg-price" label="Price" type="number" min={0} step="100" />
        </div>
        <Button
          loading={create.isPending}
          onClick={() => {
            const nameEl = document.getElementById('pkg-name') as HTMLInputElement | null;
            const priceEl = document.getElementById('pkg-price') as HTMLInputElement | null;
            const name = nameEl?.value.trim() ?? '';
            const price = Number(priceEl?.value ?? 0);
            if (!name || Number.isNaN(price)) return;
            create.mutate({ name, price });
            if (nameEl && priceEl) {
              nameEl.value = '';
              priceEl.value = '';
            }
          }}
        >
          Add package
        </Button>
      </Card>

      {rows.length === 0 ? (
        <EmptyState title="No packages yet" hint="Add your first package to start taking bookings." />
      ) : (
        <div className="space-y-3">
          {rows.map((p) => (
            <Card key={p.id} className="flex items-center justify-between gap-4">
              <div>
                <p className="font-medium text-white">{p.name}</p>
                <p className="text-sm text-ink-400">{p.description || 'No description'}</p>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-sm text-white">{p.price.toLocaleString()}</span>
                <Button variant="ghost" size="sm" onClick={() => remove.mutate(p.id)}>
                  Delete
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
