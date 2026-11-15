import type { WorkflowRunEvent } from '@pertexo/contracts';
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { CLOCK_TICK, useNow } from '@/lib/hooks/use-now';
import { useRunEvents } from '../data/run-events';
import {
  workflowRunQueryOptions,
  workflowRunVersionQueryOptions,
} from '../data/detail.queries';
import { isActiveRunStatus } from '../model/presentation/run-status';
import { upstreamSteps } from '../model/step-inspection/inputs';
import { buildRunTimeline } from '../model/timeline/runs';
import {
  eventStepLabel,
  focusRow,
  graphReadState,
  runStepLabels,
} from '../model/timeline/run-focus';
import type { RunDetailPageProps } from '../pages/run-detail';

// From a tablet up the step lens is on the page: beside the run on a wide
// screen, under the tabs below that. Only phones open it as a sheet.
const PHONE_MEDIA_QUERY = '(max-width: 47.999rem)';

/**
 * Whether the step lens stands beside the steps: only then does choosing a
 * step show its details without opening the sheet. Below the page's own
 * breakpoint the lens sits under everything, out of sight.
 */
function lensFitsBeside(lens: HTMLElement | null): boolean {
  if (lens === null) return false;
  const box = lens.getBoundingClientRect();
  const page = lens.parentElement?.getBoundingClientRect();
  return box.width > 0 && page !== undefined && box.left > page.left + 1;
}

/** One run's page state: its snapshot, live events, timeline and step lens. */
export function useRunDetail({
  apiClient,
  user,
  workspace,
  runId,
}: Omit<RunDetailPageProps, 'onRunAccepted'>) {
  const { data: snapshot } = useSuspenseQuery(
    workflowRunQueryOptions(apiClient, user.id, workspace.id, runId),
  );
  const events = useRunEvents(apiClient, user.id, workspace.id, runId);
  const { run } = snapshot;
  const canViewWorkflow = workspace.capabilities.includes('workflow:read');
  const version = useQuery({
    ...workflowRunVersionQueryOptions({
      apiClient,
      userId: user.id,
      workspaceId: workspace.id,
      workflowId: run.workflowId,
      versionId: run.workflowVersionId,
    }),
    enabled: canViewWorkflow,
  });
  const active = isActiveRunStatus(run.status);
  const nowMs = useNow({ intervalMs: CLOCK_TICK.seconds, enabled: active });
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
  const rowLabels = useMemo(() => runStepLabels(view.rows), [view.rows]);
  const stepLabel = (event: WorkflowRunEvent) =>
    eventStepLabel(event, rowLabels);

  const lensRef = useRef<HTMLElement>(null);
  function selectStep(key: string) {
    setSelectedKey(key);
    if (!lensFitsBeside(lensRef.current)) setSheetOpen(true);
  }

  const graphState = graphReadState({
    canViewWorkflow,
    failed: version.isError,
  });
  return {
    run,
    view,
    nowMs,
    version,
    events,
    compact,
    replayOpen,
    setReplayOpen,
    snapshot,
    rowLabels,
    dataScope,
    active,
    selected,
    selectStep,
    graphState,
    stepLabel,
    lensRef,
    upstream,
    sheetOpen,
    setSheetOpen,
  } as const;
}
