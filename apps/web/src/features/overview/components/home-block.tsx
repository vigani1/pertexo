import type { ReactNode } from 'react';
import { StaleLine } from '@/components/patterns/stale-line';
import { Button } from '@/components/ui/button';
import { SkeletonThread } from '@/components/ui/skeleton';
import { StatusGlyph } from '@/components/ui/status';
import { describeReadError } from '@/lib/api/api-error-copy';

export type HomeBlockState = Readonly<{
  pending: boolean;
  /** The failure of the latest read, if it failed. */
  error: unknown;
  failed: boolean;
  hasData: boolean;
  retrying: boolean;
  updatedAt: number;
  onRetry: () => void;
}>;

/**
 * One Home block with its own recovery: spooling threads while it loads, a
 * retry when its read fails, and an amber "as of" line when a refresh fails
 * but older results are still worth showing. Blocks never fail together.
 */
export function HomeBlock({
  title,
  headingId,
  actions,
  state,
  children,
}: Readonly<{
  title: string;
  headingId: string;
  actions?: ReactNode;
  state: HomeBlockState;
  children: ReactNode;
}>) {
  return (
    <section aria-labelledby={headingId} className="min-w-0">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 id={headingId} className="font-sans text-sm font-semibold">
          {title}
        </h2>
        {actions}
      </div>
      <HomeBlockBody title={title} state={state}>
        {children}
      </HomeBlockBody>
    </section>
  );
}

export function HomeBlockBody({
  title,
  state,
  children,
}: Readonly<{ title: string; state: HomeBlockState; children: ReactNode }>) {
  if (state.pending && !state.hasData)
    return (
      <div
        role="status"
        aria-label={`Loading ${title.toLocaleLowerCase()}`}
        className="flex flex-col gap-5 border-t border-white/6 py-5"
      >
        {[0, 1, 2].map((order) => (
          <SkeletonThread key={order} order={order} />
        ))}
      </div>
    );
  if (state.failed && !state.hasData)
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/6 py-4">
        <p
          role="alert"
          className="flex items-center gap-2 text-sm text-destructive"
        >
          <StatusGlyph tone="failure" />
          {describeReadError(state.error, title)}
        </p>
        <Button
          type="button"
          size="sm"
          disabled={state.retrying}
          onClick={state.onRetry}
        >
          {state.retrying ? 'Trying again…' : 'Try again'}
        </Button>
      </div>
    );
  return (
    <>
      {state.failed ? (
        <StaleLine
          className="mb-2"
          updatedAt={state.updatedAt}
          retrying={state.retrying}
          onRetry={state.onRetry}
        />
      ) : null}
      {children}
    </>
  );
}
