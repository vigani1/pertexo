import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ApiClient } from '@/lib/api/client';
import {
  workflowRunQueryOptions,
  workflowRunVersionQueryOptions,
} from './workflow-runs.queries';
import { useRunEvents } from './use-run-events';
import { isTerminalRunStatus } from './model/run-events';
import { WorkflowRunGraph } from './components/workflow-run-graph';
import { WorkflowRunLoadingWave } from './components/workflow-run-loading-wave';
import { ReplayRunDialog } from './components/replay-run-dialog';
import {
  runCancellationError,
  useRunCancellation,
} from './mutations/use-run-cancellation';

const runDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});
const runTimeFormatter = new Intl.DateTimeFormat(undefined, {
  timeStyle: 'medium',
});

export function RunDetailPage({
  apiClient,
  user,
  workspace,
  runId,
  onBackToWorkflow,
  onRunAccepted,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  runId: string;
  onBackToWorkflow: (workflowId: string) => void;
  onRunAccepted: (runId: string) => void;
}>) {
  const query = useSuspenseQuery(
    workflowRunQueryOptions(apiClient, user.id, workspace.id, runId),
  );
  const events = useRunEvents(apiClient, user.id, workspace.id, runId);
  const cancellation = useRunCancellation({
    apiClient,
    userId: user.id,
    workspaceId: workspace.id,
    runId,
  });
  const snapshot = query.data;
  const canViewWorkflow = workspace.capabilities.includes('workflow:read');
  const version = useQuery({
    ...workflowRunVersionQueryOptions(
      apiClient,
      user.id,
      workspace.id,
      snapshot.run.workflowId,
      snapshot.run.workflowVersionId,
    ),
    enabled: canViewWorkflow,
  });
  const canCancel =
    workspace.capabilities.includes('run:cancel') &&
    !isTerminalRunStatus(snapshot.run.status) &&
    snapshot.run.cancelRequestedAt === null;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <header className="glass-panel rounded-xl p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                onBackToWorkflow(snapshot.run.workflowId);
              }}
            >
              Back to workflow
            </Button>
            <h1 className="mt-3 break-all font-heading text-2xl font-semibold">
              {snapshot.run.workflowName ?? 'Workflow name unavailable'}
            </h1>
            <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
              Run {snapshot.run.id} · Workflow {snapshot.run.workflowId}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={
                isTerminalRunStatus(snapshot.run.status) ? 'muted' : 'secondary'
              }
            >
              {snapshot.run.status.replaceAll('_', ' ')}
            </Badge>
            <Badge
              variant={
                [
                  'degraded',
                  'authentication-required',
                  'access-denied',
                  'unavailable',
                  'failed',
                ].includes(events.connectionStatus)
                  ? 'destructive'
                  : 'muted'
              }
            >
              Events: {events.connectionStatus}
            </Badge>
            {workspace.capabilities.includes('run:replay') ? (
              <ReplayRunDialog
                key={`${user.id}:${workspace.id}:${snapshot.run.id}`}
                apiClient={apiClient}
                userId={user.id}
                workspaceId={workspace.id}
                sourceRunId={snapshot.run.id}
                workflowVersionId={snapshot.run.workflowVersionId}
                onRunAccepted={onRunAccepted}
              />
            ) : null}
            {canCancel ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={cancellation.isPending}
                onClick={() => {
                  cancellation.mutate();
                }}
              >
                {cancellation.isPending ? 'Requesting…' : 'Cancel run'}
              </Button>
            ) : null}
          </div>
        </div>
        {cancellation.isError ? (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {runCancellationError(cancellation.error)}
          </p>
        ) : null}
      </header>

      <section className="grid gap-4 md:grid-cols-3" aria-label="Run details">
        <Detail
          label="Accepted workflow version"
          value={snapshot.run.workflowVersionId}
          mono
        />
        <Detail label="Trigger" value={snapshot.run.triggerType} />
        <Detail label="Created" value={formatDate(snapshot.run.createdAt)} />
      </section>

      {version.data === undefined ? (
        <section className="glass-panel overflow-hidden rounded-xl">
          <div className="border-b px-5 py-4 sm:px-6">
            <h2 className="font-heading text-xl font-semibold">
              Execution map
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {canViewWorkflow
                ? version.isError
                  ? 'The exact workflow version could not be loaded. Run details remain available.'
                  : 'Loading the exact workflow version…'
                : 'Workflow read access is required to view the execution map.'}
            </p>
          </div>
          {canViewWorkflow && !version.isError ? (
            <div
              className="relative h-64 bg-background/70"
              aria-busy="true"
              aria-label="Loading execution map"
            >
              <WorkflowRunLoadingWave />
            </div>
          ) : null}
        </section>
      ) : (
        <WorkflowRunGraph
          graph={version.data.graph}
          run={snapshot.run}
          nodeRuns={snapshot.nodes}
        />
      )}

      <section className="glass-panel rounded-xl p-5 sm:p-6">
        <h2 className="font-heading text-xl font-semibold">Node invocations</h2>
        {snapshot.nodes.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            No node invocation has started yet.
          </p>
        ) : (
          <ul className="mt-4 divide-y" aria-label="Node invocations">
            {snapshot.nodes.map((node) => (
              <li
                key={node.invocationKey}
                className="grid gap-2 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{node.nodeId}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {node.invocationKey}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">
                    Attempt {String(node.currentAttemptNumber)}
                  </span>
                  <Badge variant={node.safeErrorCode ? 'destructive' : 'muted'}>
                    {node.status.replaceAll('_', ' ')}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="glass-panel rounded-xl p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-heading text-xl font-semibold">Live timeline</h2>
          {events.truncatedCount > 0 ? (
            <span className="text-sm text-muted-foreground">
              {String(events.truncatedCount)} older events omitted
            </span>
          ) : null}
        </div>
        {events.recoveryMessage === undefined ? null : (
          <p role="status" className="mt-3 text-sm text-secondary">
            {events.recoveryMessage}
          </p>
        )}
        {events.timeline.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            Waiting for the first run event…
          </p>
        ) : (
          <ol className="mt-4 space-y-2">
            {events.timeline.map((event) => (
              <li
                key={event.sequence}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-3 rounded-lg border bg-background/40 px-3 py-2 text-sm"
              >
                <span className="font-mono text-muted-foreground">
                  #{String(event.sequence)}
                </span>
                <span>{event.type.replaceAll('.', ' · ')}</span>
                <time
                  dateTime={event.createdAt}
                  className="text-muted-foreground"
                >
                  {formatTime(event.createdAt)}
                </time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function Detail({
  label,
  value,
  mono = false,
}: Readonly<{ label: string; value: string; mono?: boolean }>) {
  return (
    <div className="glass-panel rounded-xl p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p
        className={`mt-1 break-all text-sm font-medium ${mono ? 'font-mono' : ''}`}
      >
        {value}
      </p>
    </div>
  );
}

function formatDate(value: string): string {
  return runDateFormatter.format(new Date(value));
}

function formatTime(value: string): string {
  return runTimeFormatter.format(new Date(value));
}
