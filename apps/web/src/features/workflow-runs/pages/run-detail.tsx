import { PhoneFailureNotice } from "../components/run-detail/execution-history";
import { RunBusinessValues } from "../components/run-detail/business-values";
import { RunVariables } from "../components/run-detail/variables";
import { PendingTasks } from "@/features/pending-tasks/public";
import { ErrorWorkflowStatus } from "../components/error-workflow-status";
import type {
  AccessibleWorkspace,
  UserProfileResponse,
  WorkflowRunEvent,
} from "@pertexo/contracts";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { ApiClient } from "@/lib/api/client";
import { OutcomeUnknownCard } from "../components/run-detail/outcome-unknown-card";
import { RunDetailTabs } from "../components/run-detail/tabs";
import { CallHistory } from "../components/run-detail/call-history";
import { RunHeader } from "../components/run-detail/header";
import { RunStepDetails } from "../components/run-detail/step-details";
import {
  describeRunSentence,
  runEnding,
} from "../model/presentation/run-sentence";
import { isActiveRunStatus } from "../model/presentation/run-status";
import { upstreamSteps } from "../model/step-inspection/step-inputs";
import { buildRunTimeline, type RunTimelineRow } from "../model/timeline/runs";
import { useMediaQuery } from "@/lib/hooks/use-media-query";
import { useNow } from "@/lib/hooks/use-now";
import { useRunEvents } from "../hooks/use-run-events";
import {
  workflowRunQueryOptions,
  workflowRunVersionQueryOptions,
} from "../data/detail.queries";

// From a tablet up the step lens is on the page: beside the run on a wide
// screen, under the tabs below that. Only phones open it as a sheet.
const PHONE_MEDIA_QUERY = "(max-width: 47.999rem)";

/** The step worth opening first: what's running, waiting or went wrong. */
function focusRow(rows: readonly RunTimelineRow[]): RunTimelineRow | undefined {
  const order = [
    "running",
    "waiting",
    "outcome_unknown",
    "failed",
    "timed_out",
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
    if (row !== undefined && row.status !== "not_started") return row;
  }
  return rows[0];
}

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
  const canViewWorkflow = workspace.capabilities.includes("workflow:read");
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
  const nowMs = useNow({ intervalMs: 1_000, enabled: active });
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

  const lensRef = useRef<HTMLElement>(null);
  function selectStep(key: string) {
    setSelectedKey(key);
    if (!lensFitsBeside(lensRef.current)) setSheetOpen(true);
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
    // The lens stands beside the steps whenever the page has room for both
    // (a container query): the spine and the in-app browser take their share.
    <div className="@container">
      <div className="grid gap-8 @3xl:grid-cols-[minmax(0,1fr)_19rem] @3xl:gap-7 @5xl:grid-cols-[minmax(0,1fr)_22rem] @5xl:gap-8">
        <div className="flex min-w-0 flex-col gap-7">
          <RunHeader
            apiClient={apiClient}
            userId={user.id}
            workspace={workspace}
            run={run}
            sentence={describeRunSentence(
              run,
              view.rows,
              nowMs,
              runEnding(view.rows, version.data?.graph),
            )}
            nowMs={nowMs}
            versionNumber={version.data?.versionNumber}
            liveStatus={events.connectionStatus}
            compact={compact}
            replayOpen={replayOpen}
            onReplayOpenChange={setReplayOpen}
            onReconnect={events.reconnect}
            onRunAccepted={onRunAccepted}
          />
          {run.hasHumanTasks ? (
            <PendingTasks
              scope={{ apiClient, userId: user.id, workspaceId: workspace.id }}
              runId={runId}
            />
          ) : null}
          <ErrorWorkflowStatus
            delivery={snapshot.errorWorkflow}
            workspaceId={workspace.id}
          />
          <RunBusinessValues values={run.runValues} />
          <RunVariables
            scope={{
              apiClient,
              userId: user.id,
              workspaceId: workspace.id,
              runId,
            }}
          />
          <CallHistory
            calls={snapshot.calls ?? []}
            parentCall={snapshot.parentCall}
            labels={rowLabels}
            workspace={workspace}
          />
          {compact ? (
            <PhoneFailureNotice
              run={run}
              rows={view.rows}
              workspace={workspace}
            />
          ) : null}
          {run.status === "outcome_unknown" ? (
            <OutcomeUnknownCard
              stepLabel={
                view.rows.find((row) => row.status === "outcome_unknown")?.label
              }
            />
          ) : null}
          <RunDetailTabs
            scope={dataScope}
            canReplay={workspace.capabilities.includes("run:replay")}
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
                ? "forbidden"
                : version.isError
                  ? "error"
                  : "loading"
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
          ref={lensRef}
          aria-label="Step details"
          className="lens hidden self-start rounded-xl p-5 md:block @3xl:sticky @3xl:top-6 @3xl:max-h-[calc(100svh-3rem)] @3xl:overflow-y-auto"
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
          <SheetContent side={compact ? "bottom" : "right"}>
            <SheetHeader>
              <SheetTitle>{selected?.label ?? "Step"}</SheetTitle>
            </SheetHeader>
            <SheetBody>{lens}</SheetBody>
          </SheetContent>
        </Sheet>
      </div>
    </div>
  );
}
