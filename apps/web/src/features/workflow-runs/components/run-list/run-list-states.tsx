import { Link } from '@tanstack/react-router';
import { BarredThread } from '@/components/patterns/thread-illustrations';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton, SkeletonThread } from '@/components/ui/skeleton';
import { StatusGlyph } from '@/components/ui/status';

/** Spooling rows in the list's own shape while the first page loads. */
export function RunListSkeleton() {
  return (
    <div role="status" aria-label="Loading runs" className="flex flex-col">
      <Skeleton className="mb-4 ml-3 h-7 w-24" />
      {Array.from({ length: 7 }, (_, index) => (
        <div
          key={index}
          className="grid grid-cols-[6rem_minmax(0,1fr)_6rem] items-center gap-4 border-t border-white/[0.055] px-3 py-4"
        >
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-2/5" />
          <SkeletonThread order={index} />
        </div>
      ))}
    </div>
  );
}

export function RunsLoadError({
  description,
  retrying,
  onRetry,
}: Readonly<{ description: string; retrying: boolean; onRetry: () => void }>) {
  return (
    <Empty>
      <EmptyMedia>
        <StatusGlyph tone="failure" className="size-6" />
      </EmptyMedia>
      <EmptyTitle>Runs couldn’t be loaded</EmptyTitle>
      <EmptyDescription>{description}</EmptyDescription>
      <EmptyActions>
        <Button type="button" disabled={retrying} onClick={onRetry}>
          {retrying ? 'Trying again…' : 'Try again'}
        </Button>
      </EmptyActions>
    </Empty>
  );
}

export function NoMatchingRuns({
  onClearFilters,
  partial,
}: Readonly<{ onClearFilters: () => void; partial: boolean }>) {
  return (
    <Empty>
      <EmptyMedia>
        <StatusGlyph tone="skipped" className="size-6" />
      </EmptyMedia>
      <EmptyTitle>No runs match these filters</EmptyTitle>
      <EmptyDescription>
        {partial
          ? 'The trigger filter only checks runs loaded so far. Load more runs or clear the filters to see everything.'
          : 'Try a wider time range or another status, or clear the filters to see every run.'}
      </EmptyDescription>
      <EmptyActions>
        <Button type="button" onClick={onClearFilters}>
          Clear filters
        </Button>
      </EmptyActions>
    </Empty>
  );
}

export function NoRunsYet({
  workspaceId,
  canReadWorkflows,
}: Readonly<{ workspaceId: string; canReadWorkflows: boolean }>) {
  return (
    <Empty>
      <EmptyMedia>
        <StatusGlyph tone="neutral" className="size-6" />
      </EmptyMedia>
      <EmptyTitle>No runs yet</EmptyTitle>
      <EmptyDescription>
        Runs show up here once a published workflow runs, from a trigger, the
        API or Run in Build.
      </EmptyDescription>
      {canReadWorkflows ? (
        <EmptyActions>
          <Link
            to="/w/$workspaceId/workflows"
            params={{ workspaceId }}
            className={buttonVariants({ variant: 'default' })}
          >
            Go to workflows
          </Link>
        </EmptyActions>
      ) : null}
    </Empty>
  );
}

/** A 404 for the collection: the workspace's runs aren't visible to us. */
export function RunsUnavailable() {
  return (
    <Empty>
      <EmptyTitle>Runs aren’t available here</EmptyTitle>
      <EmptyDescription>
        This workspace’s runs may not exist any more, or your account may no
        longer have access to them.
      </EmptyDescription>
    </Empty>
  );
}

/** No `run:read`: the page explains instead of showing empty lists. */
export function RunsForbidden() {
  return (
    <Empty>
      <EmptyMedia className="w-full max-w-56">
        <BarredThread className="h-16" />
      </EmptyMedia>
      <EmptyTitle>Runs aren’t available for your role</EmptyTitle>
      <EmptyDescription>
        Your role in this workspace can’t see workflow runs. Ask an admin or
        owner if you need them.
      </EmptyDescription>
    </Empty>
  );
}
