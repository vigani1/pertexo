import {
  InlineFailedRead,
  QueryView,
} from '@/components/patterns/states/query-view';
import { useQuery } from '@tanstack/react-query';
import { useId, type ReactNode } from 'react';
import { Disclosure } from '@/components/ui/disclosure';
import { SkeletonLines } from '@/components/ui/skeleton';
import { nodeRunInputQueryOptions } from '../../../data/stored-values.queries';
import { feedingRows } from '../../../model/step-inspection/step-inputs';
import type { RunTimelineRow } from '../../../model/timeline/runs';
import type { RunDataScope } from './value';
import { Muted } from './value';
import { RunDataValue } from './value';
import { RunInputData } from './outputs';
import { StepOutputData } from './outputs';

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
  if (row.usesConnection ?? false)
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
