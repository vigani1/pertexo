import type {
  AccessibleWorkspace,
  UserProfileResponse,
  WorkflowRunEvent,
} from '@pertexo/contracts';
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { ApiClient } from '@/lib/api/client';
import { OutcomeUnknownCard } from '../components/run-detail/outcome-unknown-card';
import { RunDetailTabs } from '../components/run-detail/tabs';
import { RunHeader } from '../components/run-detail/header';
import {
  StepError,
  RunStepDetails,
} from '../components/run-detail/step-details';
import { describeRunSentence } from '../model/run-sentence';
import { isActiveRunStatus } from '../model/run-status';
import { upstreamSteps } from '../model/step-inspection/step-inputs';
import { buildRunTimeline, type RunTimelineRow } from '../model/timeline/runs';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { useNow } from '@/lib/hooks/use-now';
import { useRunEvents } from '../hooks/use-run-events';
import {
  workflowRunQueryOptions,
  workflowRunVersionQueryOptions,
} from '../data/workflow-runs.queries';

// From a tablet up the step lens is on the page: beside the run on a wide
// screen, under the tabs below that. Only phones open it as a sheet.
const LENS_MEDIA_QUERY = '(min-width: 48rem)';
const PHONE_MEDIA_QUERY = '(max-width: 47.999rem)';

/** The step worth opening first: what's running, waiting or went wrong. */
function focusRow(rows: readonly RunTimelineRow[]): RunTimelineRow | undefined {
  const order = [
    'running',
    'waiting',
    'outcome_unknown',
    'failed',
    'timed_out',
  ];
  const firstByStatus = new Map<string, RunTimelineRow>();
  for (const row of rows)
    if (!firstByStatus.has(row.status)) firstByStatus.set(row.status, row);
  for (const status of order) {
    const row = firstByStatus.get(status);
    if (row !== undefined) return row;
  }
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row !== undefined && row.status !== 'not_started') return row;
  }
  return rows[0];
}

/** The step whose error explains a failed run, for the phone's notice. */
function failureRow(
  status: string,
  rows: readonly RunTimelineRow[],
): (RunTimelineRow & { safeErrorCode: string }) | undefined {
  if (status !== 'failed' && status !== 'timed_out') return undefined;
  const explained = rows.filter(
    (row): row is RunTimelineRow & { safeErrorCode: string } =>
      row.safeErrorCode !== undefined,
  );
  const failed = explained.filter(
    (row) => row.status === 'failed' || row.status === 'timed_out',
  );
  return failed.at(-1) ?? explained.at(-1);
}

function lensFitsBeside(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia(LENS_MEDIA_QUERY).matches
  );
}

/** The story of one run: header, thread/graph/events/output and step lens. */
export function RunDetailPage({
  apiClient,
  user,
  workspace,
  runId,
  onRunAccepted,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  runId: string;
  onRunAccepted: (runId: string) => void;
}>) {
  const { data: snapshot } = useSuspenseQuery(
    workflowRunQueryOptions(apiClient, user.id, workspace.id, runId),
  );
  const events = useRunEvents(apiClient, user.id, workspace.id, runId);
  const { run } = snapshot;
  const canViewWorkflow = workspace.capabilities.includes('workflow:read');
  const version = useQuery({
    ...workflowRunVersionQueryOptions(
      apiClient,
      user.id,
      workspace.id,
      run.workflowId,
      run.workflowVersionId,
    ),
    enabled: canViewWorkflow,
  });
  const active = isActiveRunStatus(run.status);
  const nowMs = useNow(1_000, active);
  const view = useMemo(
    () =>
      buildRunTimeline({
        run,
        nodes: snapshot.nodes,
        events: events.timeline,
        ...(version.data === undefined ? {} : { graph: version.data.graph }),
        nowMs,
      }),
    [run, snapshot.nodes, events.timeline, version.data, nowMs],
  );
  const upstream = useMemo(
    () =>
      version.data === undefined
        ? undefined
        : upstreamSteps(version.data.graph),
    [version.data],
  );
  const dataScope = useMemo(
    () => ({ apiClient, userId: user.id, workspace, runId }),
    [apiClient, user.id, workspace, runId],
  );
  const compact = useMediaQuery(PHONE_MEDIA_QUERY);
  const [selectedKey, setSelectedKey] = useState<string>();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);
  const selected =
    view.rows.find((row) => row.key === selectedKey) ?? focusRow(view.rows);
  const rowLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const row of view.rows) {
      labels.set(row.key, row.label);
      if (!labels.has(`node:${row.nodeId}`))
        labels.set(`node:${row.nodeId}`, row.label);
    }
    return labels;
  }, [view.rows]);
  const stepLabel = (event: WorkflowRunEvent) => {
    const { invocationKey, nodeId } = event.payload;
    return (
      (invocationKey === undefined
        ? undefined
        : rowLabels.get(invocationKey)) ??
      (nodeId === undefined ? undefined : rowLabels.get(`node:${nodeId}`)) ??
      nodeId
    );
  };

  function selectStep(key: string) {
    setSelectedKey(key);
    if (!lensFitsBeside()) setSheetOpen(true);
  }

  const lens = (
    <RunStepDetails
      row={selected}
      rows={view.rows}
      upstream={upstream}
      nowMs={nowMs}
      scope={dataScope}
    />
  );

  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex min-w-0 flex-col gap-7">
        <RunHeader
          apiClient={apiClient}
          userId={user.id}
          workspace={workspace}
          run={run}
          sentence={describeRunSentence(run, view.rows, nowMs)}
          nowMs={nowMs}
          versionNumber={version.data?.versionNumber}
          liveStatus={events.connectionStatus}
          compact={compact}
          replayOpen={replayOpen}
          onReplayOpenChange={setReplayOpen}
          onReconnect={events.reconnect}
          onRunAccepted={onRunAccepted}
        />
        {compact ? (
          <PhoneFailureNotice
            run={run}
            rows={view.rows}
            workspace={workspace}
          />
        ) : null}
        {run.status === 'outcome_unknown' ? (
          <OutcomeUnknownCard
            stepLabel={
              view.rows.find((row) => row.status === 'outcome_unknown')?.label
            }
          />
        ) : null}
        <RunDetailTabs
          scope={dataScope}
          canReplay={workspace.capabilities.includes('run:replay')}
          onReplay={() => {
            setReplayOpen(true);
          }}
          view={view}
          nowMs={nowMs}
          active={active}
          selectedKey={selected?.key}
          onSelectStep={selectStep}
          graph={version.data?.graph}
          graphState={
            !canViewWorkflow
              ? 'forbidden'
              : version.isError
                ? 'error'
                : 'loading'
          }
          events={events.timeline}
          truncatedCount={events.truncatedCount}
          recoveryMessage={events.recoveryMessage}
          stepLabel={stepLabel}
          runStartMs={view.startMs}
          compact={compact}
        />
        {/* Room for the phone's action bar above the bottom navigation. */}
        {compact ? <div aria-hidden="true" className="h-14" /> : null}
      </div>
      <aside
        aria-label="Step details"
        className="lens hidden self-start rounded-xl p-5 md:block xl:sticky xl:top-6 xl:max-h-[calc(100svh-3rem)] xl:overflow-y-auto"
      >
        {selected === undefined ? null : (
          <h2 className="mb-1 font-display text-xl leading-tight [--display-optical-size:24] [--display-width:84%]">
            {selected.label}
          </h2>
        )}
        {lens}
      </aside>
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        {/* On a phone the step rises from the bottom, only as tall as it
            needs; wider screens keep the side sheet. */}
        <SheetContent side={compact ? 'bottom' : 'right'}>
          <SheetHeader>
            <SheetTitle>{selected?.label ?? 'Step'}</SheetTitle>
          </SheetHeader>
          <SheetBody>{lens}</SheetBody>
        </SheetContent>
      </Sheet>
    </div>
  );
}

/**
 * Phones: why a failed run failed, right under the header, since the step
 * lens only opens on tap there.
 */
function PhoneFailureNotice({
  run,
  rows,
  workspace,
}: Readonly<{
  run: Readonly<{ status: string }>;
  rows: readonly RunTimelineRow[];
  workspace: AccessibleWorkspace;
}>) {
  const row = failureRow(run.status, rows);
  if (row === undefined) return null;
  return (
    <section aria-label={`Why ${row.label} failed`} className="-mt-3">
      <StepError code={row.safeErrorCode} workspace={workspace} />
    </section>
  );
}
