import { Disclosure } from '@/components/ui/disclosure';
import { formatCount } from '@/lib/format/count';
import { useRunDetail } from '../hooks/use-run-detail';
import { RunFailureNotice } from '../components/run-detail/failure-notice';
import { FailedStepNotice } from '../components/run-detail/execution-history';
import { RunBusinessValues } from '../components/run-detail/business-values';
import { RunVariables } from '../components/run-detail/variables';
import { PendingTasks } from '@/features/pending-tasks/pending-tasks-views.public';
import { ErrorWorkflowStatus } from '../components/error-workflow-status';
import type {
  AccessibleWorkspace,
  UserProfileResponse,
} from '@pertexo/contracts';
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
import { CallHistory } from '../components/run-detail/call-history';
import { RunHeader } from '../components/run-detail/header';
import { RunStepDetails } from '../components/run-detail/inspection';
import {
  describeRunSentence,
  runEnding,
} from '../model/presentation/run-sentence';

/** The story of one run: header, thread/graph/events/output and step lens. */
export type RunDetailPageProps = Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  workspace: AccessibleWorkspace;
  runId: string;
  onRunAccepted: (runId: string) => void;
}>;

export function RunDetailPage(props: RunDetailPageProps) {
  const { apiClient, user, workspace, runId, onRunAccepted } = props;
  const detail = useRunDetail(props);
  const {
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
  } = detail;

  const failed = run.status === 'failed' || run.status === 'timed_out';
  const header = (
    <RunHeader
      run={run}
      failedSteps={failed ? view.rows : undefined}
      sentence={describeRunSentence(
        run,
        view.rows,
        nowMs,
        runEnding(view.rows, version.data?.graph),
      )}
      nowMs={nowMs}
      versionNumber={version.data?.versionNumber}
      compact={compact}
      live={{
        liveStatus: events.connectionStatus,
        onReconnect: events.reconnect,
      }}
      replay={{
        replayOpen,
        onReplayOpenChange: setReplayOpen,
        onRunAccepted,
      }}
      scope={{ apiClient, userId: user.id, workspace }}
    />
  );

  const details = (
    <RunDetailTabs
      scope={dataScope}
      compact={compact}
      replay={{
        canReplay: workspace.capabilities.includes('run:replay'),
        onReplay: () => {
          setReplayOpen(true);
        },
      }}
      eventStream={{
        events: events.timeline,
        truncatedCount: events.truncatedCount,
        recoveryMessage: events.recoveryMessage,
        stepLabel,
        runStartMs: view.startMs,
      }}
      graphSource={{ graph: version.data?.graph, graphState }}
      thread={{
        view,
        nowMs,
        active,
        selectedKey: selected?.key,
        onSelectStep: selectStep,
      }}
    />
  );

  return (
    <div className="@container flex flex-col gap-7">
      {header}
      <div className="grid gap-8 @3xl:grid-cols-[minmax(0,1fr)_19rem] @3xl:gap-7 @5xl:grid-cols-[minmax(0,1fr)_22rem] @5xl:gap-8">
        <div className="flex min-w-0 flex-col gap-7">
          {run.hasHumanTasks ? (
            <PendingTasks
              scope={{
                apiClient,
                userId: user.id,
                workspaceId: workspace.id,
              }}
              runId={runId}
            />
          ) : null}
          <ErrorWorkflowStatus
            delivery={snapshot.errorWorkflow}
            workspaceId={workspace.id}
          />
          <RunFailureNotice
            snapshot={snapshot}
            scope={dataScope}
            navigation={{ rows: view.rows, selectStep }}
          />
          <RunBusinessValues values={run.runValues} />
          <RunVariables scope={dataScope} />
          <CallHistory
            calls={snapshot.calls ?? []}
            parentCall={snapshot.parentCall}
            labels={rowLabels}
            workspace={workspace}
          />
          {run.failureReasonCode == null ? (
            <FailedStepNotice
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
          {failed && compact ? (
            <Disclosure
              summary={`See all ${formatCount(view.rows.length, 'step')} and the error`}
              appearance={{ tone: 'strong', look: 'framed' }}
            >
              {details}
            </Disclosure>
          ) : (
            details
          )}
          {/* Room for the phone's action bar above the bottom navigation. */}
          {compact ? <div aria-hidden="true" className="h-14" /> : null}
        </div>
        <RunInspection runDetail={detail} />
      </div>
    </div>
  );
}

function RunInspection({
  runDetail,
}: Readonly<{ runDetail: ReturnType<typeof useRunDetail> }>) {
  const {
    selected,
    lensRef,
    sheetOpen,
    setSheetOpen,
    compact,
    selectStep,
    snapshot,
    view,
    upstream,
    nowMs,
    dataScope,
  } = runDetail;
  const lens = (
    <RunStepDetails
      onSelectStep={selectStep}
      row={selected}
      calls={snapshot.calls}
      rows={view.rows}
      upstream={upstream}
      nowMs={nowMs}
      scope={dataScope}
    />
  );
  return (
    <>
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
        <SheetContent side={compact ? 'bottom' : 'right'}>
          <SheetHeader>
            <SheetTitle>{selected?.label ?? 'Step'}</SheetTitle>
          </SheetHeader>
          <SheetBody>{lens}</SheetBody>
        </SheetContent>
      </Sheet>
    </>
  );
}
