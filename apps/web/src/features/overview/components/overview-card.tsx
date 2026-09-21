import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

export function OverviewCard({
  title,
  description,
  updatedAt,
  pending,
  error,
  dataAvailable,
  empty,
  retrying,
  onRetry,
  children,
}: Readonly<{
  title: string;
  description: string;
  updatedAt?: number;
  pending: boolean;
  error: boolean;
  dataAvailable: boolean;
  empty: boolean;
  retrying: boolean;
  onRetry: () => void;
  children: ReactNode;
}>) {
  return (
    <section className="glass-panel min-w-0 rounded-xl p-5 sm:p-6">
      <header className="border-b border-border pb-4">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
        {updatedAt !== undefined && updatedAt > 0 ? (
          <p className="mt-2 font-mono text-[0.68rem] tracking-[0.08em] text-muted-foreground uppercase">
            Updated {new Date(updatedAt).toLocaleTimeString()}
          </p>
        ) : null}
      </header>

      {pending && !dataAvailable ? (
        <p role="status" className="py-10 text-sm text-muted-foreground">
          Loading…
        </p>
      ) : error && !dataAvailable ? (
        <div className="py-8">
          <p role="alert" className="text-sm text-destructive">
            This list could not be refreshed. Other overview lists are
            unaffected.
          </p>
          <Button
            className="mt-4"
            type="button"
            size="sm"
            variant="outline"
            disabled={retrying}
            onClick={onRetry}
          >
            {retrying ? 'Retrying…' : 'Try again'}
          </Button>
        </div>
      ) : (
        <>
          {error ? (
            <div
              role="alert"
              className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2"
            >
              <p className="text-sm text-destructive">
                Showing the last successful result because refresh failed.
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={retrying}
                onClick={onRetry}
              >
                {retrying ? 'Retrying…' : 'Retry refresh'}
              </Button>
            </div>
          ) : null}
          {empty ? (
            <p className="py-10 text-sm text-muted-foreground">No items yet.</p>
          ) : (
            children
          )}
        </>
      )}
    </section>
  );
}
