import { RecoverySummary } from '../recovery/summary';
import type { RunTimelineRow } from '../../model/timeline/runs';
import { RunRecoveryAction } from '../recovery/action';
import { RunDetailActions } from '../run-actions/detail';
import type {
  AccessibleWorkspace,
  WorkflowRunReadSummary,
} from '@pertexo/contracts';
import { Link } from '@tanstack/react-router';
import { RefreshCwIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { CORE_IDLE_ENERGY, CoreOrb } from '@/components/patterns/core/orb';
import { PageHeaderTitle } from '@/components/patterns/page-header';
import { Button } from '@/components/ui/button';
import { StatusMark } from '@/components/patterns/status/status-mark';
import type { ApiClient } from '@/lib/api/client';
import {
  describeLiveUpdates,
  type LiveConnectionStatus,
} from '../../model/live-updates';
import { shortRunId, workflowLabel } from '../../model/list/runs';
import {
  describeRunStatus,
  isActiveRunStatus,
  runCoreState,
} from '../../model/presentation/run-status';
import { CopyButton } from '@/components/ui/copy-button';
import { CancelRunDialog } from '../run-actions/cancel-dialog';
import { ReplayRunDialog } from '../run-actions/replay-dialog';
import { RunAdmissionBlockers } from '../run-admission-blockers';
import { RunStalledNotice } from '../run-stalled-notice';
import { RunFacts } from '../run-context/facts';

function RunLiveIndicator({
  status,
  active,
  onReconnect,
}: Readonly<{
  status: LiveConnectionStatus;
  active: boolean;
  onReconnect: () => void;
}>) {
  const look = describeLiveUpdates({ status, runActive: active });
  if (look === undefined) return null;
  return (
    <span className="inline-flex items-center gap-1.5" role="status">
      <StatusMark tone={look.tone}>{look.label}</StatusMark>
      {look.paused ? (
        <Button type="button" size="xs" variant="ghost" onClick={onReconnect}>
          <RefreshCwIcon aria-hidden="true" />
          Retry
        </Button>
      ) : null}
    </span>
  );
}

/**
 * The run's Core, a sentence that says where the run is, the facts in mono
 * and the two things you can do: replay it, or stop it while it runs.
 */
type RunHeaderProps = Readonly<{
  run: WorkflowRunReadSummary;
  sentence: string;
  failedSteps: readonly RunTimelineRow[] | undefined;
  nowMs: number;
  versionNumber: number | undefined;
  /** Phone layout: Core beside the sentence, actions in a bottom bar. */
  compact: boolean;
  scope: Readonly<{
    apiClient: ApiClient;
    userId: string;
    workspace: AccessibleWorkspace;
  }>;
  replay: Readonly<{
    /** Replay opens from here and from the run's input, so the page owns it. */
    replayOpen: boolean;
    onReplayOpenChange: (open: boolean) => void;
    onRunAccepted: (runId: string) => void;
  }>;
  live: Readonly<{ liveStatus: LiveConnectionStatus; onReconnect: () => void }>;
}>;

export function RunHeader({
  run,
  sentence,
  failedSteps,
  nowMs,
  versionNumber,
  compact,
  scope,
  replay,
  live,
}: RunHeaderProps) {
  const { apiClient, userId, workspace } = scope;

  const { replayOpen, onReplayOpenChange, onRunAccepted } = replay;

  const { liveStatus, onReconnect } = live;
  const openReplay = () => {
    onReplayOpenChange(true);
  };

  const [cancelOpen, setCancelOpen] = useState(false);
  const active = isActiveRunStatus(run.status);
  const can = (capability: AccessibleWorkspace['capabilities'][number]) =>
    workspace.capabilities.includes(capability);
  const canCancel =
    can('run:cancel') && active && run.cancelRequestedAt === null;
  const name = workflowLabel(run);
  const versionLabel =
    versionNumber === undefined ? undefined : `v${String(versionNumber)}`;

  const canReplayRun =
    can('run:replay') &&
    (run.status === 'failed' || run.status === 'outcome_unknown') &&
    workspace.status === 'active';
  const canRetry = canReplayRun && run.failureReasonCode == null;
  const canReplay = can('run:replay');
  const actions = (
    <RunDetailActions
      compact={compact}
      recoveryAction={
        canRetry ? (
          <RunRecoveryAction
            key={`${userId}:${workspace.id}:${run.id}`}
            apiClient={apiClient}
            userId={userId}
            workspace={workspace}
            runId={run.id}
            workflowId={run.workflowId}
            workflowVersionId={run.workflowVersionId}
            compact={compact}
            onRunAccepted={onRunAccepted}
            onReplay={openReplay}
          />
        ) : undefined
      }
      canReplay={canReplay}
      canCancel={canCancel}
      canOpenWorkflow={can('workflow:read')}
      onReplay={openReplay}
      onCancel={() => {
        setCancelOpen(true);
      }}
      scope={{ workspaceId: workspace.id, workflowId: run.workflowId }}
    />
  );
  return (
    // The actions wrap under the story when the column is narrow (beside
    // the step lens) instead of squeezing the title into a ribbon.
    <header className="flex flex-row flex-wrap items-start gap-x-4 gap-y-4 md:items-center md:gap-x-5">
      <RunCore status={run.status} />
      <div className="min-w-[min(100%,18rem)] flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          {can('workflow:read') ? (
            <Link
              to="/w/$workspaceId/workflows/$workflowId"
              params={{ workspaceId: workspace.id, workflowId: run.workflowId }}
              className="max-w-full min-w-0 truncate font-medium hover:text-foreground"
            >
              {name}
            </Link>
          ) : (
            <span className="max-w-full min-w-0 truncate font-medium">
              {name}
            </span>
          )}
          <CopyButton
            value={run.id}
            display={shortRunId(run.id)}
            label="Copy run ID"
          />
          <RunLiveIndicator
            status={liveStatus}
            active={active}
            onReconnect={onReconnect}
          />
        </div>
        <PageHeaderTitle size="detail" className="mt-2 break-words">
          {sentence}
        </PageHeaderTitle>
        {/* The title follows every step; this says only where the run is,
            so a screen reader hears it start, wait and finish. */}
        <p role="status" className="sr-only">
          {active
            ? describeRunStatus({
                status: run.status,
                stopRequested: run.cancelRequestedAt !== null,
              }).label
            : sentence}
        </p>
        <RunFacts
          run={run}
          nowMs={nowMs}
          workspaceId={workspace.id}
          versionLabel={versionLabel}
        />
        <RunHeaderNotices run={run} />
      </div>
      <RecoverySection
        steps={failedSteps}
        actions={actions}
        canCheckRetry={canRetry}
        canReplay={canReplay}
      />
      {can('run:replay') ? (
        <ReplayRunDialog
          key={`${userId}:${workspace.id}:${run.id}`}
          apiClient={apiClient}
          userId={userId}
          workspace={workspace}
          source={run}
          {...(versionLabel === undefined ? {} : { versionLabel })}
          open={replayOpen}
          onOpenChange={onReplayOpenChange}
          onRunAccepted={onRunAccepted}
        />
      ) : null}
      {can('run:cancel') ? (
        <CancelRunDialog
          apiClient={apiClient}
          userId={userId}
          workspaceId={workspace.id}
          runId={run.id}
          workflowName={name}
          open={cancelOpen}
          onOpenChange={setCancelOpen}
        />
      ) : null}
    </header>
  );
}

function runEnergy(status: WorkflowRunReadSummary['status']) {
  if (status === 'running') return 1.1;
  if (isActiveRunStatus(status)) return 0.6;
  return CORE_IDLE_ENERGY;
}

function RunCore({
  status,
}: Readonly<{ status: WorkflowRunReadSummary['status'] }>) {
  return (
    <div className="size-16 shrink-0 md:size-28">
      <CoreOrb
        state={runCoreState(status)}
        energy={runEnergy(status)}
        className="size-full"
      />
    </div>
  );
}

function RunHeaderNotices({ run }: Readonly<{ run: WorkflowRunReadSummary }>) {
  return (
    <>
      <RunAdmissionBlockers
        run={run}
        className="mt-3 text-sm text-muted-foreground"
      />
      <RunStalledNotice run={run} className="mt-3" />
    </>
  );
}

function RecoverySection({
  steps,
  actions,
  canCheckRetry,
  canReplay,
}: Readonly<{
  steps: RunHeaderProps['failedSteps'];
  actions: ReactNode;
  canCheckRetry: boolean;
  canReplay: boolean;
}>) {
  if (steps === undefined) return actions;
  return (
    <RecoverySummary
      rows={steps}
      actions={actions}
      canCheckRetry={canCheckRetry}
      canReplay={canReplay}
    />
  );
}
