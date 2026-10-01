import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const variants: Record<Variant, string> = {
  primary: 'bg-amber-400 text-ink-950 hover:bg-amber-500 shadow-[0_8px_30px_-12px_rgba(242,182,76,0.6)]',
  secondary: 'bg-ink-800 text-white hover:bg-ink-700 border border-ink-700',
  ghost: 'text-ink-300 hover:text-white hover:bg-ink-800',
  danger: 'bg-rose-500 text-white hover:bg-rose-500/90',
};

const sizes: Record<Size, string> = {
  sm: 'h-9 px-3 text-sm',
  md: 'h-11 px-5 text-sm',
  lg: 'h-13 px-7 text-base',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', loading, disabled, children, ...props }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-full font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
        'disabled:cursor-not-allowed disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {loading && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  ),
);
Button.displayName = 'Button';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, id, ...props }, ref) => (
    <label className="block space-y-1.5" htmlFor={id}>
      {label && <span className="text-sm font-medium text-ink-300">{label}</span>}
      <input
        ref={ref}
        id={id}
        className={cn(
          'h-11 w-full rounded-xl border bg-ink-900 px-3.5 text-sm text-white placeholder:text-ink-400',
          'focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-400/20',
          error ? 'border-rose-500' : 'border-ink-700',
          className,
        )}
        {...props}
      />
      {error && <span className="text-xs text-rose-500">{error}</span>}
    </label>
  ),
);
Input.displayName = 'Input';

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('card p-5', className)}>{children}</div>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-5 animate-spin text-ink-400', className)} />;
}

export function PageLoader() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <Spinner className="size-7" />
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-2xl border border-dashed border-ink-700 px-6 py-14 text-center">
      <p className="text-sm font-medium text-white">{title}</p>
      {hint && <p className="text-sm text-ink-400">{hint}</p>}
    </div>
  );
}
