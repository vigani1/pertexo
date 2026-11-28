import type { ReactNode } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import { roleLimitSentence } from '@/features/workspaces/public';
import { Link } from '@tanstack/react-router';
import {
  BarredThread,
  LooseThread,
} from '@/components/patterns/states/thread-illustrations';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from '@/components/patterns/states/empty';
import { Skeleton, SkeletonThread } from '@/components/ui/skeleton';

/** Spooling rows in the list's own shape while the first page loads. */
export function RunListSkeleton() {
  return (
    <div role="status" aria-label="Loading runs" className="flex flex-col">
      <Skeleton className="mb-4 ml-3 h-7 w-24" />
      {Array.from({ length: 7 }, (_, index) => (
        <div
          key={index}
          className="grid grid-cols-[6rem_minmax(0,1fr)_6rem] items-center gap-4 border-t border-border px-3 py-4"
        >
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-2/5" />
          <SkeletonThread order={index} />
        </div>
      ))}
    </div>
  );
}

export function NoMatchingRuns({
  onClearFilters,
  partial,
}: Readonly<{ onClearFilters: () => void; partial: boolean }>) {
  return (
    <IllustratedRunEmpty
      title="No runs match these filters"
      description={
        <>
          {partial
            ? 'The trigger filter only checks runs loaded so far. Load more runs or clear the filters to see everything.'
            : 'Try a wider time range or another status, or clear the filters to see every run.'}
        </>
      }
    >
      <Button type="button" variant="outline" onClick={onClearFilters}>
        Clear filters
      </Button>
    </IllustratedRunEmpty>
  );
}

export function NoRunsYet({
  workspaceId,
  canReadWorkflows,
}: Readonly<{ workspaceId: string; canReadWorkflows: boolean }>) {
  return (
    <IllustratedRunEmpty
      title="No runs yet"
      description={
        <>
          Runs show up here once a published workflow runs, from one of its
          triggers or from Run in its editor.
        </>
      }
    >
      {canReadWorkflows ? (
        <>
          <Link
            to="/w/$workspaceId/workflows"
            params={{ workspaceId }}
            className={buttonVariants({ variant: 'primary' })}
          >
            Go to workflows
          </Link>
        </>
      ) : null}
    </IllustratedRunEmpty>
  );
}

/** A workflow that hasn't run: the way on is its editor, not the list. */
export function NoWorkflowRunsYet({
  workspaceId,
  workflowId,
}: Readonly<{ workspaceId: string; workflowId: string }>) {
  return (
    <IllustratedRunEmpty
      title="No runs yet"
      description={
        <>
          This workflow’s runs show up here once it’s published and runs, from
          one of its triggers or from Run in Build.
        </>
      }
    >
      <Link
        to="/w/$workspaceId/workflows/$workflowId"
        params={{ workspaceId, workflowId }}
        className={buttonVariants({ variant: 'primary' })}
      >
        Open Build
      </Link>
    </IllustratedRunEmpty>
  );
}

function IllustratedRunEmpty({
  title,
  description,
  children,
}: Readonly<{ title: string; description: ReactNode; children: ReactNode }>) {
  return (
    <Empty>
      <EmptyMedia className="w-full max-w-56">
        <LooseThread />
      </EmptyMedia>
      <EmptyTitle>{title}</EmptyTitle>
      <EmptyDescription>{description}</EmptyDescription>
      {children == null || children === false ? null : (
        <EmptyActions>{children}</EmptyActions>
      )}
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
type WorkspaceRole = AccessibleWorkspace['role'];

export function RunsForbidden({ role }: Readonly<{ role: WorkspaceRole }>) {
  return (
    <Empty>
      <EmptyMedia className="w-full max-w-56">
        <BarredThread className="h-16" />
      </EmptyMedia>
      <EmptyTitle>Runs aren’t available for your role</EmptyTitle>
      <EmptyDescription>
        {roleLimitSentence(role, 'run:read', 'see workflow runs')}
      </EmptyDescription>
    </Empty>
  );
}
