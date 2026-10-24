import type {
  AccessibleWorkspace,
  WorkflowStepHealth,
  WorkflowStepHealthResponse,
  WorkflowStepRun,
  WorkflowStepRunsResponse,
} from '@pertexo/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { InfoHint } from '@/components/patterns/guidance/info-hint';
import { QueryView } from '@/components/patterns/states/query-view';
import { SkeletonRows } from '@/components/ui/skeleton';
import { StatusGlyph } from '@/components/ui/status';
import type { ApiClient } from '@/lib/api/client';
import { formatDurationMs, formatRelativeTime } from '@/lib/format/time';
import { cn } from '@/lib/utils';
import { describeNodeStatus } from '../../model/presentation/run-status';
import { shortStepError } from '../../model/step-inspection/step-error-copy';
import { loopItemOf } from '../../model/timeline/runs';
import {
  stepHealthQueryOptions,
  stepRunsQueryOptions,
} from '../../data/detail.queries';
import { StepRunOutput } from '../run-detail/data/outputs';

const RECENT_RUNS = 10;

function durationOf(run: WorkflowStepRun): number | undefined {
  if (run.startedAt === null || run.completedAt === null) return undefined;
  return Date.parse(run.completedAt) - Date.parse(run.startedAt);
}

function Section({
  title,
  hint,
  children,
}: Readonly<{ title: string; hint?: ReactNode; children: ReactNode }>) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <h3 className="font-sans text-xs font-semibold text-subtle-foreground">
          {title}
        </h3>
        {hint === undefined ? null : (
          <InfoHint title={title} className="-my-1">
            {hint}
          </InfoHint>
        )}
      </div>
      {children}
    </section>
  );
}

function Tile({
  label,
  value,
  note,
  tone,
}: Readonly<{
  label: string;
  value: string;
  note?: string;
  tone?: 'success' | 'failure' | undefined;
}>) {
  return (
    <div className="rounded-md border border-surface-ink/6 bg-surface-ink/[0.02] px-3 py-2">
      <p className="text-[0.7rem] text-subtle-foreground">{label}</p>
      <p
        className={cn(
          'mt-0.5 font-mono text-base font-medium tabular-nums',
          tone === 'success' && 'text-success',
          tone === 'failure' && 'text-destructive',
        )}
      >
        {value}
      </p>
      {note === undefined ? null : (
        <p className="font-mono text-[0.7rem] text-subtle-foreground">{note}</p>
      )}
    </div>
  );
}

/** Ran, succeeded, failed and how long it usually takes. */
function HealthTiles({ health }: Readonly<{ health: WorkflowStepHealth }>) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <Tile label="Ran" value={`${String(health.runs)}×`} />
      <Tile
        label="Succeeded"
        value={String(health.succeeded)}
        tone={health.succeeded > 0 ? 'success' : undefined}
      />
      <Tile
        label="Failed"
        value={String(health.failed)}
        tone={health.failed > 0 ? 'failure' : undefined}
      />
      <Tile
        label="Usually takes"
        value={
          health.medianDurationMs === null
            ? '—'
            : formatDurationMs(health.medianDurationMs)
        }
        {...(health.p95DurationMs === null
          ? {}
          : { note: `slowest ${formatDurationMs(health.p95DurationMs)}` })}
      />
    </div>
  );
}

/** One run of the step: how it ended, when, and why if it failed. */
function RecentRun({
  run,
  workspaceId,
  actions,
}: Readonly<{
  run: WorkflowStepRun;
  workspaceId: string;
  actions?: ReactNode;
}>) {
  const look = describeNodeStatus(run.status);
  const item = loopItemOf(run.invocationKey);
  const took = durationOf(run);
  return (
    <li>
      <Link
        to="/w/$workspaceId/runs/$runId"
        params={{ workspaceId, runId: run.runId }}
        className="flex items-start gap-2.5 rounded-md px-2 py-1.5 outline-none transition-colors hover:bg-surface-ink/[0.04] focus-ring motion-reduce:transition-none"
      >
        <StatusGlyph tone={look.tone} className="mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="block text-[0.82rem]">
            {look.label}
            {item === undefined ? null : (
              <span className="text-subtle-foreground"> · {item}</span>
            )}
          </span>
          {run.safeErrorCode === null ? null : (
            <span className="block truncate text-xs text-muted-foreground">
              {shortStepError(run.safeErrorCode)}
            </span>
          )}
        </span>
        <span className="shrink-0 text-right font-mono text-[0.7rem] text-subtle-foreground">
          {formatRelativeTime(run.runCreatedAt)}
          {took === undefined ? null : (
            <span className="block">{formatDurationMs(took)}</span>
          )}
        </span>
      </Link>
      {actions}
    </li>
  );
}

/**
 * A step's record in real runs, where it's built: how it has been doing
 * across the workflow's last 100 runs, what it returned last time, and its
 * latest runs, each opening its run (ADR 051).
 */
export function StepHistoryPanel({
  apiClient,
  userId,
  workspace,
  workflowId,
  nodeId,
  stepLabel,
  renderActions,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
  nodeId: string;
  stepLabel: string;
  renderActions?: (run: WorkflowStepRun) => ReactNode;
}>) {
  const canRead = workspace.capabilities.includes('run:read');
  const health = useQuery({
    ...stepHealthQueryOptions(apiClient, userId, workspace.id, workflowId),
    enabled: canRead,
  });
  const runs = useQuery({
    ...stepRunsQueryOptions(apiClient, userId, workspace.id, {
      workflowId,
      nodeId,
      limit: RECENT_RUNS,
    }),
    enabled: canRead,
  });
  if (!canRead)
    return (
      <p className="text-sm text-muted-foreground">
        Your role can’t see runs, so this step’s history is hidden.
      </p>
    );
  const loading = <SkeletonRows label="Loading this step’s runs" />;
  return (
    <QueryView query={health} resource="This step’s record" loading={loading}>
      {(healthData) => (
        <QueryView query={runs} resource="This step’s runs" loading={loading}>
          {(runsData) => (
            <StepRecord
              health={healthData}
              runs={runsData}
              scope={{ apiClient, userId, workspace }}
              nodeId={nodeId}
              stepLabel={stepLabel}
              renderActions={renderActions}
            />
          )}
        </QueryView>
      )}
    </QueryView>
  );
}

function StepRecord({
  health,
  runs,
  scope: { apiClient, userId, workspace },
  nodeId,
  stepLabel,
  renderActions,
}: Readonly<{
  health: WorkflowStepHealthResponse;
  runs: WorkflowStepRunsResponse;
  scope: Readonly<{
    apiClient: ApiClient;
    userId: string;
    workspace: AccessibleWorkspace;
  }>;
  nodeId: string;
  stepLabel: string;
  renderActions: ((run: WorkflowStepRun) => ReactNode) | undefined;
}>) {
  const { runsConsidered, oldestRunAt } = health;
  const stepHealth = health.items.find((item) => item.nodeId === nodeId);
  if (runsConsidered === 0)
    return (
      <p className="text-sm text-muted-foreground">
        This workflow hasn’t run yet. Publish it and run it, and you’ll see how
        this step does here.
      </p>
    );
  if (stepHealth === undefined)
    return (
      <p className="text-sm text-muted-foreground">
        This step hasn’t run in the workflow’s last {String(runsConsidered)}{' '}
        runs. A step added since the last publish runs once you publish again.
      </p>
    );
  const lastResult = runs.items.find((run) => run.status === 'succeeded');
  return (
    <div className="flex flex-col gap-6">
      <Section
        title="How it’s been doing"
        hint={
          <p>
            From the workflow’s last {String(runsConsidered)} runs. A step
            inside a loop counts once per item. “Usually takes” is the middle of
            its successful runs; “slowest” is how long the slowest 5% took.
          </p>
        }
      >
        <HealthTiles health={stepHealth} />
        <p className="font-mono text-[0.7rem] text-subtle-foreground">
          last {String(runsConsidered)} runs
          {oldestRunAt === null
            ? ''
            : ` · since ${formatRelativeTime(oldestRunAt)}`}
        </p>
      </Section>
      {lastResult === undefined ? null : (
        <Section title="Last result">
          <p className="text-xs text-subtle-foreground">
            From the run{' '}
            <Link
              to="/w/$workspaceId/runs/$runId"
              params={{ workspaceId: workspace.id, runId: lastResult.runId }}
              className="text-foreground underline decoration-white/20 underline-offset-4 hover:decoration-foreground"
            >
              {formatRelativeTime(lastResult.runCreatedAt)}
            </Link>
          </p>
          <StepRunOutput
            nodeRunId={lastResult.nodeRunId}
            status={lastResult.status}
            scope={{ apiClient, userId, workspace, runId: lastResult.runId }}
            title={`Last result of ${stepLabel}`}
          />
        </Section>
      )}
      <Section title="Recent runs">
        <ul className="-mx-2 flex flex-col">
          {runs.items.map((run) => (
            <RecentRun
              key={run.nodeRunId}
              run={run}
              workspaceId={workspace.id}
              actions={renderActions?.(run)}
            />
          ))}
        </ul>
      </Section>
    </div>
  );
}
