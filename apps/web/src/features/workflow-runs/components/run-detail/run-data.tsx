import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type { WorkflowRunData } from '@pertexo/contracts/schemas/workflow-runs';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { Maximize2Icon, RefreshCwIcon } from 'lucide-react';
import { useState } from 'react';
import { JsonTree } from '@/components/patterns/json-tree';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { ArtifactDownload } from '@/features/artifacts/public';
import type { ApiClient } from '@/lib/api/client';
import {
  nodeRunOutputQueryOptions,
  workflowRunInputQueryOptions,
} from '../../workflow-runs.queries';
import { describeValue, isEmptyValue } from '../../model/run-data-summary';
import { feedingRows } from '../../model/step-inputs';
import type { ThreadRow } from '../../model/thread-view';

export type RunDataScope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  runId: string;
}>;

function Muted({ children }: Readonly<{ children: string }>) {
  return <p className="text-[0.8rem] text-muted-foreground">{children}</p>;
}

/** Inline JSON: a tree to browse, with its size, Copy and a wider view. */
function InlineValue({
  value,
  title,
}: Readonly<{ value: unknown; title: string }>) {
  const [expanded, setExpanded] = useState(false);
  const summary = describeValue(value);
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-mono text-[0.7rem] text-subtle-foreground">
          {summary}
        </span>
        <div className="-mr-1.5 flex items-center">
          <CopyButton
            value={JSON.stringify(value, null, 2)}
            label={`Copy ${title}`}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Expand ${title}`}
            title="Expand"
            onClick={() => {
              setExpanded(true);
            }}
          >
            <Maximize2Icon aria-hidden="true" />
          </Button>
        </div>
      </div>
      <JsonTree value={value} label={title} className="max-h-72" />
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="max-w-3xl">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{summary}</DialogDescription>
          <JsonTree
            value={value}
            label={title}
            className="mt-4 max-h-[60svh]"
          />
          <div className="mt-4 flex justify-end">
            <DialogClose render={<Button type="button" variant="ghost" />}>
              Close
            </DialogClose>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** One stored value: a tree of JSON, a file, or why there's nothing. */
function RunDataValue({
  data,
  title,
  emptyText,
  scope,
}: Readonly<{
  data: WorkflowRunData;
  /** Names the value for Copy and Expand: "Data out of Set fields". */
  title: string;
  emptyText: string;
  scope: RunDataScope;
}>) {
  switch (data.kind) {
    case 'inline':
      return isEmptyValue(data.value) ? (
        <Muted>{emptyText}</Muted>
      ) : (
        <InlineValue value={data.value} title={title} />
      );
    case 'artifact':
      return scope.workspace.capabilities.includes('artifact:read') ? (
        <ArtifactDownload
          apiClient={scope.apiClient}
          userId={scope.userId}
          workspaceId={scope.workspace.id}
          artifactId={data.artifactId}
        />
      ) : (
        <Muted>This is a file, and your role can’t download files.</Muted>
      );
    case 'none':
      return <Muted>{emptyText}</Muted>;
    case 'expired':
      return (
        <Muted>No longer kept. Pertexo keeps a run’s input for 30 days.</Muted>
      );
  }
}

/** A stored value being read: a quiet placeholder, then the value or a retry. */
function RunDataRead({
  query,
  title,
  emptyText,
  scope,
}: Readonly<{
  query: UseQueryResult<WorkflowRunData>;
  title: string;
  emptyText: string;
  scope: RunDataScope;
}>) {
  if (query.data !== undefined)
    return (
      <RunDataValue
        data={query.data}
        title={title}
        emptyText={emptyText}
        scope={scope}
      />
    );
  if (query.isError)
    return (
      <div className="flex flex-wrap items-center gap-2 text-[0.8rem] text-muted-foreground">
        <span>Couldn’t load this.</span>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCwIcon aria-hidden="true" />
          Try again
        </Button>
      </div>
    );
  return (
    <div role="status" aria-label={`Loading ${title}`}>
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

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

const UNFINISHED: ReadonlySet<ThreadRow['status']> = new Set([
  'pending',
  'ready',
  'running',
  'waiting',
]);

/** What one step run produced, once it has something to show. */
export function StepOutputData({
  row,
  scope,
  title,
}: Readonly<{ row: ThreadRow; scope: RunDataScope; title: string }>) {
  const nodeRunId = row.nodeRunId;
  const query = useQuery({
    ...nodeRunOutputQueryOptions(
      scope.apiClient,
      scope.userId,
      scope.workspace.id,
      scope.runId,
      { nodeRunId: nodeRunId ?? '', status: row.status },
    ),
    enabled: nodeRunId !== undefined,
  });
  const nothingYet =
    UNFINISHED.has(row.status) &&
    (query.data === undefined || query.data.kind === 'none');
  if (nodeRunId === undefined || nothingYet)
    return (
      <Muted>
        {row.status === 'not_started'
          ? 'This step hasn’t run, so it has no data.'
          : 'Shows up when the step finishes.'}
      </Muted>
    );
  return (
    <RunDataRead
      query={query}
      title={title}
      emptyText={
        row.status === 'succeeded'
          ? 'This step finished without returning anything.'
          : 'This step didn’t return anything.'
      }
      scope={scope}
    />
  );
}

/**
 * What a step received. A step nothing connects into gets the run's input;
 * any other gets what the steps connected into it returned. The exact input
 * after mappings isn't kept (ADR 050), so this is where it came from.
 */
export function StepInputData({
  row,
  rows,
  upstream,
  scope,
}: Readonly<{
  row: ThreadRow;
  rows: readonly ThreadRow[];
  /** Steps connected into each step; undefined while the version loads. */
  upstream: ReadonlyMap<string, readonly string[]> | undefined;
  scope: RunDataScope;
}>) {
  if (upstream === undefined)
    return <Muted>Shows up once this run’s steps have loaded.</Muted>;
  if ((upstream.get(row.nodeId) ?? []).length === 0)
    return (
      <div className="flex flex-col gap-1.5">
        <p className="text-xs text-subtle-foreground">The run’s input</p>
        <RunInputData scope={scope} title={`Data in of ${row.label}`} />
      </div>
    );
  const sources = feedingRows(row, rows, upstream);
  if (sources.length === 0)
    return (
      <Muted>
        {row.status === 'not_started'
          ? 'Comes from the steps before it, once they run.'
          : 'Nothing was kept from the steps before it.'}
      </Muted>
    );
  return (
    <div className="flex flex-col gap-4">
      {sources.map((source) => (
        <div key={source.key} className="flex flex-col gap-1.5">
          <p className="text-xs text-subtle-foreground">
            From <span className="text-foreground">{source.label}</span>
          </p>
          <StepOutputData
            row={source}
            scope={scope}
            title={`Data out of ${source.label}`}
          />
        </div>
      ))}
    </div>
  );
}
