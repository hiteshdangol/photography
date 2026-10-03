import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { request, errorMessage } from '@/lib/api';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Input,
  PageLoader,
  Textarea,
} from '@/components/ui';

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

interface CreateInput {
  name: string;
  description: string;
  price: string;
}

export function PackagesManagerPage() {
  const queryClient = useQueryClient();
  const [pendingDelete, setPendingDelete] = useState<PackageRow | null>(null);

  const { data, isPending, isError } = useQuery({
    queryKey: ['packages', 'mine'],
    queryFn: () => request<PackagesResponse>({ url: '/packages/mine' }),
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateInput>({ defaultValues: { name: '', description: '', price: '' } });

  const create = useMutation({
    mutationFn: (body: { name: string; description?: string; price: number }) =>
      request<unknown>({ url: '/packages', method: 'POST', data: body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['packages'] });
      reset();
      toast.success('Package created.');
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not create that package.')),
  });

  const remove = useMutation({
    mutationFn: (id: string) => request<unknown>({ url: `/packages/${id}`, method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['packages'] });
      setPendingDelete(null);
      toast.success('Package deleted.');
    },
    onError: (error) => toast.error(errorMessage(error, 'Could not delete that package.')),
  });

  const onSubmit = handleSubmit((values) => {
    create.mutate({
      name: values.name.trim(),
      description: values.description.trim() || undefined,
      price: Number(values.price),
    });
  });

  if (isPending) return <PageLoader />;
  if (isError) {
    return <EmptyState title="We could not load your packages yet." hint="Try again in a moment." />;
  }

  const rows = data?.packages ?? [];

  return (
    <div className="space-y-6">
      <h1 className="text-display text-3xl font-semibold tracking-tight">Packages</h1>

      <Card>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
            <Input
              id="pkg-name"
              label="Name"
              placeholder="Signature session"
              error={errors.name?.message}
              {...register('name', {
                required: 'Give the package a name.',
                minLength: { value: 2, message: 'Use at least 2 characters.' },
                maxLength: { value: 80, message: 'Keep it under 80 characters.' },
              })}
            />
            <Input
              id="pkg-price"
              label="Price"
              type="number"
              min={0}
              step={100}
              inputMode="numeric"
              placeholder="25000"
              error={errors.price?.message}
              {...register('price', {
                required: 'Set a price.',
                validate: (value) =>
                  Number.isFinite(Number(value)) && Number(value) >= 0 ? true : 'Enter a number of 0 or more.',
              })}
            />
          </div>

          <Textarea
            id="pkg-description"
            label="Description"
            rows={3}
            placeholder="4 hours · 1 photographer · 200 edited photos"
            error={errors.description?.message}
            {...register('description', { maxLength: { value: 500, message: 'Keep it under 500 characters.' } })}
          />

          <div className="flex justify-end">
            <Button type="submit" loading={create.isPending}>
              Add package
            </Button>
          </div>
        </form>
      </Card>

      {rows.length === 0 ? (
        <EmptyState title="No packages yet" hint="Add your first package to start taking bookings." />
      ) : (
        <div className="space-y-3">
          {rows.map((p) => (
            <Card key={p.id} className="flex flex-wrap items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-medium text-white">{p.name}</p>
                  <Badge tone={p.active ? 'emerald' : 'ink'}>{p.active ? 'active' : 'hidden'}</Badge>
                </div>
                <p className="text-sm text-ink-400">{p.description || 'No description'}</p>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-sm text-white">{p.price.toLocaleString()}</span>
                <Button variant="ghost" size="sm" onClick={() => setPendingDelete(p)}>
                  Delete
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete.id)}
        title="Delete this package?"
        description={
          pendingDelete
            ? `"${pendingDelete.name}" will stop appearing on your public profile. Existing bookings keep their price snapshot.`
            : undefined
        }
        confirmLabel="Delete package"
        destructive
        loading={remove.isPending}
      />
    </div>
  );
}
