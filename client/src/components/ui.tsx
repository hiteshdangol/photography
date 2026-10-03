import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react';
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

/* -------------------------------------------------------------------------- */
/* Status                                                                      */
/* -------------------------------------------------------------------------- */

export type Tone = 'neutral' | 'amber' | 'emerald' | 'rose' | 'ink';

const tones: Record<Tone, string> = {
  neutral: 'bg-ink-800 text-ink-200 border-ink-700',
  amber: 'bg-amber-400/15 text-amber-300 border-amber-400/30',
  emerald: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  rose: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  ink: 'bg-ink-900 text-ink-400 border-ink-700',
};

/**
 * Status pill. Booking, payment and invoice states all render through this, so
 * one place decides what "approved" looks like.
 */
export function Badge({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium capitalize',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Maps a domain status string onto a tone. Unknown values fall back to `neutral`
 * rather than throwing: a new server-side status should not blank a page.
 */
export function toneForStatus(status: string | undefined | null): Tone {
  switch ((status ?? '').toLowerCase()) {
    case 'approved':
    case 'completed':
    case 'paid':
    case 'published':
    case 'active':
    case 'delivered':
      return 'emerald';
    case 'pending':
    case 'pending_verification':
    case 'partially_paid':
    case 'editing':
    case 'shooting':
      return 'amber';
    case 'rejected':
    case 'cancelled':
    case 'failed':
    case 'void':
    case 'suspended':
      return 'rose';
    default:
      return 'neutral';
  }
}

/* -------------------------------------------------------------------------- */
/* Form fields                                                                 */
/* -------------------------------------------------------------------------- */

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, label, error, id, rows = 4, ...props }, ref) => (
    <label className="block space-y-1.5" htmlFor={id}>
      {label && <span className="text-sm font-medium text-ink-300">{label}</span>}
      <textarea
        ref={ref}
        id={id}
        rows={rows}
        className={cn(
          'w-full rounded-xl border bg-ink-900 px-3.5 py-3 text-sm text-white placeholder:text-ink-400',
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
Textarea.displayName = 'Textarea';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, label, error, id, children, ...props }, ref) => (
    <label className="block space-y-1.5" htmlFor={id}>
      {label && <span className="text-sm font-medium text-ink-300">{label}</span>}
      <select
        ref={ref}
        id={id}
        className={cn(
          'h-11 w-full rounded-xl border bg-ink-900 px-3 text-sm text-white',
          'focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-400/20',
          error ? 'border-rose-500' : 'border-ink-700',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      {error && <span className="text-xs text-rose-500">{error}</span>}
    </label>
  ),
);
Select.displayName = 'Select';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, label, id, ...props }, ref) => {
    const generated = useId();
    const inputId = id ?? generated;
    return (
      <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink-300" htmlFor={inputId}>
        <input
          ref={ref}
          id={inputId}
          type="checkbox"
          className={cn(
            'size-4 shrink-0 rounded border-ink-600 bg-ink-900 accent-amber-400',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
            className,
          )}
          {...props}
        />
        {label}
      </label>
    );
  },
);
Checkbox.displayName = 'Checkbox';

/* -------------------------------------------------------------------------- */
/* Layout                                                                      */
/* -------------------------------------------------------------------------- */

export function SectionHeading({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-display text-xl font-semibold tracking-tight text-white">{title}</h2>
        {hint && <p className="mt-1 text-sm text-ink-400">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

/**
 * A single dashboard metric. `hint` carries the secondary line the spec asks for
 * under each figure ("12% approved", "NPR 40,000 outstanding").
 */
export function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
}) {
  return (
    <Card>
      <p className="text-xs uppercase tracking-wide text-ink-400">{label}</p>
      <p className={cn('mt-2 text-3xl font-semibold', tone === 'rose' ? 'text-rose-300' : 'text-white')}>
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-ink-400">{hint}</p>}
    </Card>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-xl bg-ink-800', className)} />;
}

/** Placeholder rows used while a table loads, so the layout does not jump. */
export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-3', className)}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  );
}

export function Avatar({
  name,
  src,
  size = 40,
  className,
}: {
  name?: string | null;
  src?: string | null;
  size?: number;
  className?: string;
}) {
  const initials = (name ?? '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  if (src) {
    return (
      <img
        src={src}
        alt={name ?? ''}
        width={size}
        height={size}
        loading="lazy"
        className={cn('shrink-0 rounded-full object-cover', className)}
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-ink-800 font-medium text-ink-300',
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
    >
      {initials || '?'}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Table                                                                       */
/* -------------------------------------------------------------------------- */

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-ink-700">
      <table className={cn('w-full border-collapse text-left text-sm', className)} {...props} />
    </div>
  );
}

export function Th({ className, ...props }: HTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={cn(
        'whitespace-nowrap border-b border-ink-700 bg-ink-900/60 px-4 py-3 text-xs font-medium uppercase tracking-wide text-ink-400',
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, ...props }: HTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('border-b border-ink-800 px-4 py-3 align-middle text-ink-200', className)} {...props} />;
}

export function Tr({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('transition-colors hover:bg-ink-900/40', className)} {...props} />;
}

/* -------------------------------------------------------------------------- */
/* Tabs                                                                        */
/* -------------------------------------------------------------------------- */

export interface TabItem {
  value: string;
  label: ReactNode;
}

export function Tabs({
  items,
  value,
  onChange,
  className,
}: {
  items: TabItem[];
  value: string;
  onChange: (next: string) => void;
  className?: string;
}) {
  return (
    <div role="tablist" className={cn('flex flex-wrap gap-1 border-b border-ink-700', className)}>
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.value)}
            className={cn(
              '-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60',
              active ? 'border-amber-400 text-white' : 'border-transparent text-ink-400 hover:text-ink-200',
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Modal                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Portal-rendered dialog with Escape-to-close and a scroll lock on the body.
 * Focus moves to the panel on open and returns to the trigger on close, which is
 * the minimum needed for the dialog to be keyboard-usable.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    restoreFocusTo.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreFocusTo.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl' } as const;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/70 backdrop-blur-sm"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          'animate-fade-up relative w-full rounded-2xl border border-ink-700 bg-ink-900 p-6 shadow-2xl',
          'focus:outline-none',
          widths[size],
        )}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 rounded-full p-1.5 text-ink-400 transition-colors hover:bg-ink-800 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
        >
          <X className="size-4" />
        </button>

        <h2 className="text-display pr-8 text-xl font-semibold tracking-tight text-white">{title}</h2>
        {description && <p className="mt-1.5 text-sm text-ink-400">{description}</p>}

        {children && <div className="mt-5">{children}</div>}
        {footer && <div className="mt-6 flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Confirmation for destructive or irreversible actions. Used instead of
 * `window.confirm`, which cannot be styled and blocks the main thread.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive,
  loading,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  children?: ReactNode;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Pagination                                                                  */
/* -------------------------------------------------------------------------- */

export function Pagination({
  page,
  totalPages,
  total,
  limit,
  onChange,
}: {
  page: number;
  totalPages: number;
  total?: number;
  limit?: number;
  onChange: (next: number) => void;
}) {
  if (totalPages <= 1) return null;

  const canPrev = page > 1;
  const canNext = page < totalPages;

  return (
    <nav className="flex flex-wrap items-center justify-between gap-3 pt-2" aria-label="Pagination">
      <p className="text-xs text-ink-400">
        Page {page} of {totalPages}
        {typeof total === 'number' && <span> · {total.toLocaleString()} total</span>}
        {typeof limit === 'number' && total !== undefined && (
          <span> · {Math.min(limit, Math.max(0, total - (page - 1) * limit))} on this page</span>
        )}
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={!canPrev}
          onClick={() => onChange(page - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft className="size-4" />
          Previous
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!canNext}
          onClick={() => onChange(page + 1)}
          aria-label="Next page"
        >
          Next
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </nav>
  );
}

/* -------------------------------------------------------------------------- */
/* Progress                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Determinate progress bar. Used for multi-file uploads, where the spec asks
 * for an explicit "Uploading 73 / 250" rather than an indeterminate spinner.
 */
export function ProgressBar({
  value,
  max,
  label,
  className,
}: {
  value: number;
  max: number;
  label?: string;
  className?: string;
}) {
  const safeMax = Math.max(1, max);
  const pct = Math.min(100, Math.round((value / safeMax) * 100));

  return (
    <div className={cn('space-y-1.5', className)}>
      {label && (
        <div className="flex items-center justify-between text-xs text-ink-400">
          <span>{label}</span>
          <span className="tabular-nums">{pct}%</span>
        </div>
      )}
      <div
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-label={label ?? 'Progress'}
        className="h-1.5 w-full overflow-hidden rounded-full bg-ink-800"
      >
        <div className="h-full rounded-full bg-amber-400 transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}