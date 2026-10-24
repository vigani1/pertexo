import { useQuery } from '@tanstack/react-query';
import {
  nodeRunOutputQueryOptions,
  workflowRunInputQueryOptions,
} from '../../../data/stored-values.queries';
import type { RunTimelineRow } from '../../../model/timeline/runs';
import type { RunDataScope } from './value';
import { Muted } from './value';
import { RunDataRead } from './value';

/** The run's own input, as the trigger handed it over. */
export function RunInputData({
  scope,
  title = 'Run input',
}: Readonly<{ scope: RunDataScope; title?: string }>) {
  const query = useQuery(
    workflowRunInputQueryOptions(
      scope.apiClient,
      scope.userId,
      scope.workspace.id,
      scope.runId,
    ),
  );
  return (
    <RunDataRead
      query={query}
      title={title}
      emptyText="This run started without input."
      scope={scope}
    />
  );
}

const UNFINISHED: ReadonlySet<RunTimelineRow['status']> = new Set([
  'pending',
  'ready',
  'running',
  'waiting',
]);

/**
 * What one step run produced, once it has something to show: in this run,
 * or in any run of the workflow (`scope.runId` names which).
 */
export function StepRunOutput({
  nodeRunId,
  status,
  scope,
  title,
  emptyText,
}: Readonly<{
  nodeRunId: string | undefined;
  status: RunTimelineRow['status'];
  scope: RunDataScope;
  title: string;
  emptyText?: string;
}>) {
  const query = useQuery({
    ...nodeRunOutputQueryOptions({
      apiClient: scope.apiClient,
      userId: scope.userId,
      workspaceId: scope.workspace.id,
      runId: scope.runId,
      step: { nodeRunId: nodeRunId ?? '', status },
    }),
    enabled: nodeRunId !== undefined,
  });
  const nothingYet =
    UNFINISHED.has(status) &&
    (query.data === undefined || query.data.kind === 'none');
  if (nodeRunId === undefined || nothingYet)
    return (
      <Muted>
        {status === 'not_started'
          ? 'This step hasn’t run, so it has no data.'
          : 'Shows up when the step finishes.'}
      </Muted>
    );
  return (
    <RunDataRead
      query={query}
      title={title}
      emptyText={
        emptyText ??
        (status === 'succeeded'
          ? 'This step finished without returning anything.'
          : 'This step didn’t return anything.')
      }
      scope={scope}
    />
  );
}

/** What one step run in this run produced. */
export function StepOutputData({
  row,
  scope,
  title,
}: Readonly<{ row: RunTimelineRow; scope: RunDataScope; title: string }>) {
  return (
    <StepRunOutput
      nodeRunId={row.nodeRunId}
      status={row.status}
      scope={scope}
      title={title}
      {...(row.reused === undefined
        ? {}
        : { emptyText: 'The saved output is empty.' })}
    />
  );
}
