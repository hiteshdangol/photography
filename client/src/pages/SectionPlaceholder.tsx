import { EmptyState } from '@/components/ui';

export function SectionPlaceholder({ title }: { title: string }) {
  return (
    <div className="space-y-6">
      <h1 className="text-display text-3xl font-semibold tracking-tight">{title}</h1>
      <EmptyState title={`${title} is coming together`} hint="This section is being built out." />
    </div>
  );
}
