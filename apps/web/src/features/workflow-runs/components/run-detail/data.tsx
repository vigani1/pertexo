import {
  InlineFailedRead,
  QueryView,
} from '@/components/patterns/states/query-view';
import type { AccessibleWorkspace, WorkflowRunData } from '@pertexo/contracts';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { Maximize2Icon } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { JsonTree } from '@/components/patterns/code/json-tree';
import { Button } from '@/components/ui/button';
import { Disclosure } from '@/components/ui/disclosure';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { SkeletonLines } from '@/components/ui/skeleton';
import { ArtifactDownload, FilePages } from '@/features/artifacts/public';
import type { ApiClient } from '@/lib/api/client';
import {
  nodeRunInputQueryOptions,
  nodeRunOutputQueryOptions,
  workflowRunInputQueryOptions,
} from '../../data/stored-values.queries';
import {
  describeValue,
  isEmptyValue,
} from '../../model/step-inspection/run-data-summary';
import { feedingRows } from '../../model/step-inspection/step-inputs';
import type { RunTimelineRow } from '../../model/timeline/runs';

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
        <>
          {scope.workspace.capabilities.includes('artifact:read') ? (
            <FilePages
              value={data.value}
              apiClient={scope.apiClient}
              workspaceId={scope.workspace.id}
            />
          ) : null}
          <InlineValue value={data.value} title={title} />
        </>
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
  return (
    <QueryView
      query={query}
      resource={title}
      loading={<SkeletonLines label={`Loading ${title}`} />}
      error={(failed) => (
        <InlineFailedRead text="Couldn’t load this." {...failed} />
      )}
    >
      {(data) => (
        <RunDataValue
          data={data}
          title={title}
          emptyText={emptyText}
          scope={scope}
        />
      )}
    </QueryView>
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

/** Statuses in which a step's current attempt may still record its input. */
const RECORDING: ReadonlySet<RunTimelineRow['status']> = new Set([
  'pending',
  'ready',
  'running',
]);

/**
 * What a step received: exactly, as its current attempt recorded it (ADR 052),
 * with where it came from folded underneath. Without a recording, it says
 * why, and shows where the input came from as source data.
 */
export function StepInputData({
  row,
  rows,
  upstream,
  scope,
}: Readonly<{
  row: RunTimelineRow;
  rows: readonly RunTimelineRow[];
  upstream: ReadonlyMap<string, readonly string[]> | undefined;
  scope: RunDataScope;
}>) {
  const nodeRunId = row.nodeRunId;
  // Skipped steps never received input; upstream values aren't their input.
  if (row.status === 'skipped')
    return <Muted>This step was skipped, so it received no input.</Muted>;
  const sources = (
    <InputSources row={row} rows={rows} upstream={upstream} scope={scope} />
  );
  // A step that hasn't run yet only has where its input will come from.
  if (nodeRunId === undefined) return sources;
  // What a connected step receives is what it sends, which isn't kept.
  if (row.usesConnection === true)
    return (
      <div className="flex flex-col gap-4">
        <Muted>
          Not kept: this step sends it through a connection, and Pertexo doesn’t
          store what steps send.
        </Muted>
        <SourceData>{sources}</SourceData>
      </div>
    );
  return (
    <RecordedStepInput row={row} nodeRunId={nodeRunId} scope={scope}>
      {sources}
    </RecordedStepInput>
  );
}

/** This reader exists only for a step whose input may be retained. */
function RecordedStepInput({
  row,
  nodeRunId,
  scope,
  children,
}: Readonly<{
  row: RunTimelineRow;
  nodeRunId: string;
  scope: RunDataScope;
  children: ReactNode;
}>) {
  const recorded = useQuery({
    ...nodeRunInputQueryOptions({
      apiClient: scope.apiClient,
      userId: scope.userId,
      workspaceId: scope.workspace.id,
      runId: scope.runId,
      step: {
        nodeRunId,
        attemptNumber: row.currentAttemptNumber,
        status: row.status,
      },
    }),
  });
  return (
    <QueryView
      query={recorded}
      resource={`Data in of ${row.label}`}
      loading={<SkeletonLines label={`Loading Data in of ${row.label}`} />}
      error={(failed) => (
        <div className="flex flex-col gap-4">
          <InlineFailedRead
            text="Couldn’t load exactly what this step received."
            {...failed}
          />
          <SourceData>{children}</SourceData>
        </div>
      )}
    >
      {(data) =>
        data.kind === 'inline' || data.kind === 'artifact' ? (
          <div className="flex flex-col gap-3">
            {row.attempts > 1 ? (
              <Muted>What the latest attempt received.</Muted>
            ) : null}
            <RunDataValue
              data={data}
              title={`Data in of ${row.label}`}
              emptyText="This step received nothing."
              scope={scope}
            />
            <SourcesDisclosure>{children}</SourcesDisclosure>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <Muted>{unrecordedInput(data.kind, row.status)}</Muted>
            <SourceData>{children}</SourceData>
          </div>
        )
      }
    </QueryView>
  );
}

/** Why the exact input isn't shown. */
function unrecordedInput(
  kind: string,
  status: RunTimelineRow['status'],
): string {
  if (kind === 'expired')
    return 'No longer kept. Pertexo keeps run data for 30 days.';
  if (RECORDING.has(status)) return 'Not recorded yet.';
  return 'Pertexo didn’t keep exactly what this step received, for example because it was over 256 KB.';
}

/** Names where the input came from for what it is: not the exact input. */
function SourceNote() {
  return (
    <p className="text-[0.8rem] text-muted-foreground">
      Source data, not the exact input: this step’s own mappings may have
      changed it.
    </p>
  );
}

/** Where the input came from, shown when there's no exact input to show. */
function SourceData({ children }: Readonly<{ children: ReactNode }>) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <p id={headingId} className="text-xs text-subtle-foreground">
        Where it came from
      </p>
      <SourceNote />
      {children}
    </section>
  );
}

/** Mounts the sources only once opened, so their reads wait until asked. */
function SourcesDisclosure({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <Disclosure
      summary="Where it came from"
      size="xs"
      lazy
      contentClassName="flex flex-col gap-2"
    >
      <SourceNote />
      {children}
    </Disclosure>
  );
}

/**
 * Where a step's input came from. A step nothing connects into gets the
 * run's input; any other gets what the steps connected into it returned.
 */
function InputSources({
  row,
  rows,
  upstream,
  scope,
}: Readonly<{
  row: RunTimelineRow;
  rows: readonly RunTimelineRow[];
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
        <RunInputData scope={scope} />
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
