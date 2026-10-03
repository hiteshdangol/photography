import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui';

interface Props {
  children: ReactNode;
  /** Rendered instead of the default 500 panel when supplied. */
  fallback?: (reset: () => void, error: Error) => ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time failures so one broken section cannot blank the whole app.
 *
 * A class component because `componentDidCatch` has no hook equivalent, and
 * because an error boundary that itself throws during render would loop. The
 * fallback UI is intentionally local rather than imported from `pages/`, so the
 * boundary has no route-level dependencies.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Console rather than a toast: the boundary already renders a full-page
    // state, and stacking a toast on top of it reads as a second failure.
    console.error('Unhandled render error', error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback(this.reset, error);

    return (
      <div className="mx-auto flex min-h-[60vh] w-full max-w-2xl flex-col items-center justify-center px-5 text-center">
        <p className="text-display text-6xl font-semibold text-amber-400">500</p>
        <h1 className="mt-4 text-display text-2xl font-semibold tracking-tight text-white">
          Something went wrong on our side
        </h1>
        <p className="mt-2 text-sm text-ink-400">
          The error has been logged. Try again, and if it keeps happening we will look into it.
        </p>
        <p className="mt-4 max-w-md break-words text-xs text-ink-500">{error.message}</p>
        <Button className="mt-6" onClick={this.reset}>
          Try again
        </Button>
      </div>
    );
  }
}