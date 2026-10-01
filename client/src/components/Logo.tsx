import { Link } from 'react-router-dom';
import { Aperture } from 'lucide-react';
import { cn } from '@/lib/cn';

export function Logo({ className, to = '/' }: { className?: string; to?: string }) {
  return (
    <Link to={to} className={cn('inline-flex items-center gap-2', className)}>
      <span className="grid size-9 place-items-center rounded-xl bg-amber-400 text-ink-950">
        <Aperture className="size-5" strokeWidth={2.4} />
      </span>
      <span className="text-display text-xl font-semibold tracking-tight text-white">LensFlow</span>
    </Link>
  );
}
