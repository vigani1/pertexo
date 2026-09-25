import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type { WorkflowRunReadSummary } from '@pertexo/contracts/schemas/workflow-runs';
import { Link } from '@tanstack/react-router';
import { OctagonXIcon, RefreshCwIcon, RotateCcwIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { CoreOrb } from '@/components/patterns/core-orb';
import {
  PageHeaderActions,
  PageHeaderMeta,
  PageHeaderTitle,
} from '@/components/patterns/page-header';
import { Button } from '@/components/ui/button';
import { Status } from '@/components/ui/status';
import type { ApiClient } from '@/lib/api/client';
import { formatClock, formatDurationMs } from '@/lib/format-time';
import {
  describeLiveUpdates,
  type LiveConnectionStatus,
} from '../../model/live-updates';
import { runDurationMs, shortRunId, workflowLabel } from '../../model/run-list';
import {
  describeTrigger,
  isActiveRunStatus,
  runCoreState,
} from '../../model/run-status';
import { CopyButton } from '@/components/ui/copy-button';
import { CancelRunDialog } from '../run-actions/cancel-run-dialog';
import { ReplayRunDialog } from '../run-actions/replay-run-dialog';

function MetaFact({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <span className="[&_b]:font-medium [&_b]:text-foreground">{children}</span>
  );
}

function deadlineFact(run: WorkflowRunReadSummary, nowMs: number): ReactNode {
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
  const look = describeLiveUpdates(status, active);
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
    </PageHeaderMeta>
  );
}

/**
 * The run's Core, a sentence that says where the run is, the facts in mono
 * and the two things you can do: replay it, or stop it while it runs.
 */
export function RunHeader({
  apiClient,
  userId,
  workspace,
  run,
  sentence,
  nowMs,
  versionNumber,
  liveStatus,
  onReconnect,
  onRunAccepted,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  run: WorkflowRunReadSummary;
  sentence: string;
  nowMs: number;
  versionNumber: number | undefined;
  liveStatus: LiveConnectionStatus;
  onReconnect: () => void;
  onRunAccepted: (runId: string) => void;
}>) {
  const [dialog, setDialog] = useState<'replay' | 'cancel'>();
  const active = isActiveRunStatus(run.status);
  const can = (capability: AccessibleWorkspace['capabilities'][number]) =>
    workspace.capabilities.includes(capability);
  const canCancel =
    can('run:cancel') && active && run.cancelRequestedAt === null;
  const name = workflowLabel(run);
  const versionLabel =
    versionNumber === undefined ? undefined : `v${String(versionNumber)}`;

  return (
    <header className="flex flex-col gap-5 md:flex-row md:items-center">
      <div className="size-24 shrink-0 md:size-28">
        <CoreOrb
          state={runCoreState(run.status)}
          energy={run.status === 'running' ? 1.1 : 0.6}
          className="size-full"
        />
      </div>
      <div className="min-w-0 flex-1">
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
      </div>
      <PageHeaderActions className="md:self-start">
        {can('run:replay') ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setDialog('replay');
            }}
          >
            <RotateCcwIcon aria-hidden="true" />
            Replay
          </Button>
        ) : null}
        {canCancel ? (
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              setDialog('cancel');
            }}
          >
            <OctagonXIcon aria-hidden="true" />
            Cancel run
          </Button>
        ) : null}
      </PageHeaderActions>
      {can('run:replay') ? (
        <ReplayRunDialog
          key={`${userId}:${workspace.id}:${run.id}`}
          apiClient={apiClient}
          userId={userId}
          workspaceId={workspace.id}
          sourceRunId={run.id}
          workflowVersionId={run.workflowVersionId}
          {...(versionLabel === undefined ? {} : { versionLabel })}
          open={dialog === 'replay'}
          onOpenChange={(open) => {
            setDialog(open ? 'replay' : undefined);
          }}
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
          open={dialog === 'cancel'}
          onOpenChange={(open) => {
            setDialog(open ? 'cancel' : undefined);
          }}
        />
      ) : null}
    </header>
  );
}
