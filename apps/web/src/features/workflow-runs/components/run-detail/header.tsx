import { RunRecoveryAction } from '../recovery/action';
import { RunDetailActions } from '../run-actions/detail-actions';
import type {
  AccessibleWorkspace,
  WorkflowRunReadSummary,
} from '@pertexo/contracts';
import { Link } from '@tanstack/react-router';
import { RefreshCwIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { CORE_IDLE_ENERGY, CoreOrb } from '@/components/patterns/core/orb';
import {
  PageHeaderMeta,
  PageHeaderTitle,
} from '@/components/patterns/page-header';
import { Button } from '@/components/ui/button';
import { Status } from '@/components/ui/status';
import type { ApiClient } from '@/lib/api/client';
import {
  formatClock,
  formatDurationMs,
  formatDateTime,
} from '@/lib/format/time';
import {
  describeLiveUpdates,
  type LiveConnectionStatus,
} from '../../model/live-updates';
import { StatusGuide } from '@/components/patterns/guidance/status-guide';
import { RUN_PAGE_GUIDE } from '../../model/presentation/run-guide';
import {
  runDurationMs,
  shortRunId,
  workflowLabel,
} from '../../model/list/runs';
import {
  describeTrigger,
  isActiveRunStatus,
  runCoreState,
} from '../../model/presentation/run-status';
import { CopyButton } from '@/components/ui/copy-button';
import { CancelRunDialog } from '../run-actions/cancel-run-dialog';
import { ReplayRunDialog } from '../run-actions/replay-run-dialog';
import { RunAdmissionBlockers } from '../run-admission-blockers';

function MetaFact({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <span className="[&_b]:font-medium [&_b]:text-foreground">{children}</span>
  );
}

function deadlineFact(run: WorkflowRunReadSummary, nowMs: number): ReactNode {
  if (run.humanWait !== undefined)
    return (
      <>
        execution budget paused
        {run.humanWait.absoluteDeadlineAt === null ? null : (
          <>
            {' '}
            · absolute deadline{' '}
            <b>{formatDateTime(run.humanWait.absoluteDeadlineAt)}</b>
          </>
        )}
      </>
    );
  if (run.deadlineAt === null) return 'no deadline';
  const remaining = Date.parse(run.deadlineAt) - nowMs;
  if (!isActiveRunStatus(run.status))
    return (
      <>
        deadline <b>{formatClock(run.deadlineAt)}</b>
      </>
    );
  return remaining > 0 ? (
    <>
      deadline in <b>{formatDurationMs(remaining)}</b>
    </>
  ) : (
    'deadline passed'
  );
}

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
      <Status tone={look.tone}>{look.label}</Status>
      {look.paused ? (
        <Button type="button" size="xs" variant="ghost" onClick={onReconnect}>
          <RefreshCwIcon aria-hidden="true" />
          Retry
        </Button>
      ) : null}
    </span>
  );
}

/** The run's facts in mono: start, duration, trigger, version, deadline, stop. */
function RunFacts({
  run,
  nowMs,
  workspaceId,
  versionLabel,
}: Readonly<{
  run: WorkflowRunReadSummary;
  nowMs: number;
  workspaceId: string;
  versionLabel: string | undefined;
}>) {
  const active = isActiveRunStatus(run.status);
  const durationMs = runDurationMs(run, nowMs);
  return (
    <PageHeaderMeta>
      <MetaFact>
        started <b>{formatClock(run.startedAt ?? run.createdAt)}</b>
      </MetaFact>
      {durationMs === undefined ? null : (
        <MetaFact>
          <b>{formatDurationMs(durationMs)}</b>{' '}
          {active ? 'elapsed' : 'in total'}
        </MetaFact>
      )}
      <MetaFact>
        {describeTrigger(run.triggerType).toLocaleLowerCase()}
      </MetaFact>
      {versionLabel === undefined ? null : (
        <MetaFact>
          version{' '}
          <Link
            to="/w/$workspaceId/workflows/$workflowId/versions"
            params={{
              workspaceId,
              workflowId: run.workflowId,
            }}
            className="font-medium text-foreground underline decoration-white/20 underline-offset-4 hover:decoration-foreground"
          >
            {versionLabel}
          </Link>
        </MetaFact>
      )}
      <MetaFact>{deadlineFact(run, nowMs)}</MetaFact>
      {run.cancelRequestedAt === null ? null : (
        <MetaFact>
          stop requested <b>{formatClock(run.cancelRequestedAt)}</b>
        </MetaFact>
      )}
      {run.replaySourceRunId == null ? null : (
        <MetaFact>
          {run.recovery === undefined ? 'replay of' : 'recovered from'}{' '}
          <Link
            to="/w/$workspaceId/runs/$runId"
            params={{ workspaceId, runId: run.replaySourceRunId }}
            className="font-medium text-foreground underline decoration-white/20 underline-offset-4 hover:decoration-foreground"
          >
            {shortRunId(run.replaySourceRunId)}
          </Link>
        </MetaFact>
      )}
      {run.recovery === undefined ? null : (
        <MetaFact>
          {String(run.recovery.reusedCount)} earlier{' '}
          {run.recovery.reusedCount === 1 ? 'step' : 'steps'} reused
        </MetaFact>
      )}
      <StatusGuide sections={RUN_PAGE_GUIDE} className="-my-1 -ml-2" />
    </PageHeaderMeta>
  );
}

/**
 * The run's Core, a sentence that says where the run is, the facts in mono
 * and the two things you can do: replay it, or stop it while it runs.
 */
type RunHeaderProps = Readonly<{
  run: WorkflowRunReadSummary;
  sentence: string;
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
  return (
    // The actions wrap under the story when the column is narrow (beside
    // the step lens) instead of squeezing the title into a ribbon.
    <header className="flex flex-row flex-wrap items-start gap-x-4 gap-y-4 md:items-center md:gap-x-5">
      <div className="size-16 shrink-0 md:size-28">
        <CoreOrb
          state={runCoreState(run.status)}
          energy={runEnergy(run.status)}
          className="size-full"
        />
      </div>
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
        <PageHeaderTitle className="mt-2 text-3xl break-words [--display-width:78%] sm:text-[2.5rem]">
          {sentence}
        </PageHeaderTitle>
        <RunFacts
          run={run}
          nowMs={nowMs}
          workspaceId={workspace.id}
          versionLabel={versionLabel}
        />
        <RunAdmissionBlockers
          run={run}
          className="mt-3 text-sm text-muted-foreground"
        />
      </div>
      <RunDetailActions
        compact={compact}
        recoveryAction={
          canReplayRun ? (
            <RunRecoveryAction
              key={`${userId}:${workspace.id}:${run.id}`}
              apiClient={apiClient}
              userId={userId}
              workspaceId={workspace.id}
              runId={run.id}
              workflowVersionId={run.workflowVersionId}
              compact={compact}
              onRunAccepted={onRunAccepted}
              onReplay={() => {
                onReplayOpenChange(true);
              }}
            />
          ) : undefined
        }
        canReplay={can('run:replay')}
        canCancel={canCancel}
        canOpenWorkflow={can('workflow:read')}
        onReplay={() => {
          onReplayOpenChange(true);
        }}
        onCancel={() => {
          setCancelOpen(true);
        }}
        scope={{ workspaceId: workspace.id, workflowId: run.workflowId }}
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
