import { Button, EmptyState } from '@/components/ui';

/**
 * 404. Not wired to the root catch-all yet: `App.tsx` redirects unknown paths to
 * `/`, and `routing.integration.test.tsx` pins that behaviour deliberately.
 * Available for any nested section that needs a scoped not-found.
 */
export function NotFoundPage() {
  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-24 text-center">
      <p className="text-display text-6xl font-semibold text-amber-400">404</p>
      <h1 className="mt-4 text-display text-2xl font-semibold tracking-tight text-white">
        We could not find that page
      </h1>
      <p className="mt-2 text-sm text-ink-400">
        The link may be out of date, or the gallery may have been made private.
      </p>
      <a href="/" className="mt-6 inline-block">
        <Button>Back to home</Button>
      </a>
    </div>
  );
}

/** 403. Distinct from 404 on purpose: this is a known resource you may not see. */
export function ForbiddenPage({ message }: { message?: string }) {
  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-24 text-center">
      <p className="text-display text-6xl font-semibold text-amber-400">403</p>
      <h1 className="mt-4 text-display text-2xl font-semibold tracking-tight text-white">
        This area is not available to you
      </h1>
      <EmptyState
        title={message ?? 'You are not authorized to view this.'}
        hint="If you believe this is a mistake, ask the photographer to share it with your account."
      />
    </div>
  );
}

/** 500. */
export function ErrorPage({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-24 text-center">
      <p className="text-display text-6xl font-semibold text-amber-400">500</p>
      <h1 className="mt-4 text-display text-2xl font-semibold tracking-tight text-white">
        Something went wrong on our side
      </h1>
      <p className="mt-2 text-sm text-ink-400">
        The error has been logged. Try again, and if it keeps happening we will look into it.
      </p>
      {onRetry && (
        <Button className="mt-6" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}