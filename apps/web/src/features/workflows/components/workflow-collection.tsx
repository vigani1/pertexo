import type { WorkflowSummary } from '@pertexo/contracts/schemas/workflow-authoring';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { AuroraLoadingPanel } from '@/components/patterns/aurora-loading-panel';
import { GlassSection } from '@/components/patterns/glass-section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import type { ApiClient } from '@/lib/api/client';
import { CreateWorkflowDialog } from '../create-workflow-dialog';

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function WorkflowCollection({
  workflows,
  workspaceId,
  apiClient,
  userId,
  canCreate,
  pending,
  refreshing,
  errorMessage,
  retrying,
  hasNextPage,
  loadingNextPage,
  nextPageError,
  onRetry,
  onLoadMore,
  onRetryNextPage,
}: Readonly<{
  workflows: readonly WorkflowSummary[];
  workspaceId: string;
  apiClient: ApiClient;
  userId: string;
  canCreate: boolean;
  pending: boolean;
  refreshing: boolean;
  errorMessage?: string;
  retrying: boolean;
  hasNextPage: boolean;
  loadingNextPage: boolean;
  nextPageError: boolean;
  onRetry: () => void;
  onLoadMore: () => void;
  onRetryNextPage: () => void;
}>) {
  const hasData = workflows.length > 0;
  return (
    <AuroraLoadingPanel active={pending || refreshing || loadingNextPage}>
      <GlassSection
        className="overflow-hidden"
        aria-busy={pending || refreshing || loadingNextPage}
        aria-label="Workspace workflows"
      >
        {refreshing && hasData ? (
          <p
            role="status"
            className="border-b px-4 py-2 text-xs text-muted-foreground sm:px-5"
          >
            Refreshing workflows…
          </p>
        ) : null}

        {errorMessage !== undefined && hasData ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-3 border-b border-destructive/25 bg-destructive/5 px-4 py-3 sm:px-5"
          >
            <p className="text-sm text-destructive">
              Showing the last loaded workflows. {errorMessage}
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

        {pending ? (
          <p role="status" className="px-5 py-16 text-sm text-muted-foreground">
            Loading workflows…
          </p>
        ) : errorMessage !== undefined && !hasData ? (
          <Empty className="border-0 px-5">
            <EmptyTitle>Workflows are unavailable</EmptyTitle>
            <EmptyDescription>{errorMessage}</EmptyDescription>
            <Button
              className="mt-6"
              type="button"
              variant="outline"
              onClick={onRetry}
            >
              Try again
            </Button>
          </Empty>
        ) : !hasData ? (
          <Empty className="border-0 px-5">
            <EmptyTitle>No workflows yet</EmptyTitle>
            <EmptyDescription>
              Create the first workflow for this workspace when you are ready to
              automate a process.
            </EmptyDescription>
            {canCreate ? (
              <div className="mt-6">
                <CreateWorkflowDialog
                  apiClient={apiClient}
                  userId={userId}
                  workspaceId={workspaceId}
                  triggerLabel="Create the first workflow"
                />
              </div>
            ) : null}
          </Empty>
        ) : (
          <div>
            <div
              aria-hidden="true"
              className="hidden grid-cols-[minmax(12rem,1fr)_6.5rem_6.5rem_10rem] gap-3 border-b px-5 py-3 font-mono text-xs tracking-[0.06em] text-muted-foreground lg:grid"
            >
              <span>Workflow</span>
              <span>Lifecycle</span>
              <span>Activation</span>
              <span>Updated</span>
            </div>
            <ul className="divide-y" aria-label="Workspace workflows">
              {workflows.map((workflow) => (
                <WorkflowRow
                  key={workflow.id}
                  workflow={workflow}
                  workspaceId={workspaceId}
                />
              ))}
            </ul>
          </div>
        )}

        {hasData && (hasNextPage || nextPageError) ? (
          <div className="flex flex-wrap items-center justify-center gap-3 border-t px-4 py-4 sm:px-5">
            {hasNextPage || nextPageError ? (
              <Button
                type="button"
                variant="outline"
                disabled={loadingNextPage}
                onClick={nextPageError ? onRetryNextPage : onLoadMore}
              >
                {loadingNextPage
                  ? 'Loading…'
                  : nextPageError
                    ? 'Retry next page'
                    : 'Load more'}
              </Button>
            ) : null}
            {nextPageError ? (
              <p role="alert" className="text-sm text-destructive">
                The next workflow page could not be loaded. Existing workflows
                are unchanged.
              </p>
            ) : null}
          </div>
        ) : null}
      </GlassSection>
    </AuroraLoadingPanel>
  );
}

function WorkflowRow({
  workflow,
  workspaceId,
}: Readonly<{ workflow: WorkflowSummary; workspaceId: string }>) {
  return (
    <li className="grid gap-3 px-4 py-4 transition-colors hover:bg-primary/[0.025] sm:px-5 lg:grid-cols-[minmax(12rem,1fr)_6.5rem_6.5rem_10rem] lg:items-center lg:gap-3">
      <div className="min-w-0">
        <WorkflowLink workflow={workflow} workspaceId={workspaceId} />
        <p
          className="mt-1 truncate font-mono text-xs text-muted-foreground"
          title={workflow.id}
        >
          {workflow.id}
        </p>
      </div>
      <StatusDetail label="Lifecycle">
        <LifecycleBadge workflow={workflow} />
      </StatusDetail>
      <StatusDetail label="Activation">
        <ActivationBadge workflow={workflow} />
      </StatusDetail>
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground lg:block lg:text-sm">
        <span className="shrink-0 lg:sr-only">Updated</span>
        <time dateTime={workflow.updatedAt} className="min-w-0">
          {dateFormatter.format(new Date(workflow.updatedAt))}
        </time>
      </div>
    </li>
  );
}

function StatusDetail({
  label,
  children,
}: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div className="flex min-w-0 items-center gap-2 lg:block">
      <span className="shrink-0 text-xs text-muted-foreground lg:sr-only">
        {label}
      </span>
      {children}
    </div>
  );
}

function WorkflowLink({
  workflow,
  workspaceId,
}: Readonly<{ workflow: WorkflowSummary; workspaceId: string }>) {
  return (
    <Link
      to="/w/$workspaceId/workflows/$workflowId"
      params={{ workspaceId, workflowId: workflow.id }}
      title={workflow.name}
      className="block max-w-full truncate font-heading text-base font-semibold text-foreground hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {workflow.name}
    </Link>
  );
}

function LifecycleBadge({ workflow }: Readonly<{ workflow: WorkflowSummary }>) {
  return (
    <Badge
      aria-label={`Lifecycle: ${workflow.lifecycleStatus}`}
      variant={workflow.lifecycleStatus === 'active' ? 'default' : 'muted'}
    >
      {workflow.lifecycleStatus}
    </Badge>
  );
}

function ActivationBadge({
  workflow,
}: Readonly<{ workflow: WorkflowSummary }>) {
  return (
    <Badge
      aria-label={`Activation: ${workflow.activationStatus}`}
      variant={workflow.activationStatus === 'active' ? 'secondary' : 'muted'}
    >
      {workflow.activationStatus}
    </Badge>
  );
}
