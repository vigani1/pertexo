import type { ReactNode } from 'react';
import { AuroraLoadingPanel } from '@/components/patterns/aurora-loading-panel';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type OverviewCardAppearance = 'resume' | 'attention' | 'activity';

const surfaceClassName: Record<OverviewCardAppearance, string> = {
  resume: 'p-5 sm:p-6',
  attention: 'border-destructive/20 bg-destructive/[0.02] p-5',
  activity: 'overflow-hidden',
};

const headerClassName: Record<OverviewCardAppearance, string> = {
  resume: 'border-border pb-4',
  attention: 'border-destructive/15 pb-3',
  activity: 'border-border bg-white/[0.018] px-5 py-4 sm:px-6',
};

const updatedTimeFormatter = new Intl.DateTimeFormat(undefined, {
  timeStyle: 'short',
});

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
  className,
  appearance = 'resume',
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
  className?: string;
  appearance?: OverviewCardAppearance;
}>) {
  return (
    <AuroraLoadingPanel active={pending || retrying} className={className}>
      <section
        className={cn(
          'glass-panel h-full min-w-0 rounded-xl',
          surfaceClassName[appearance],
        )}
      >
        <header className={cn('border-b', headerClassName[appearance])}>
          <h2
            className={cn(
              'font-semibold tracking-tight',
              appearance === 'resume' ? 'text-2xl' : 'text-lg',
            )}
          >
            {title}
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
          {updatedAt !== undefined && updatedAt > 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Updated {updatedTimeFormatter.format(new Date(updatedAt))}
            </p>
          ) : null}
        </header>

        <div className={appearance === 'activity' ? 'px-5 sm:px-6' : undefined}>
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
                <p className="py-10 text-sm text-muted-foreground">
                  No items yet.
                </p>
              ) : (
                children
              )}
            </>
          )}
        </div>
      </section>
    </AuroraLoadingPanel>
  );
}
