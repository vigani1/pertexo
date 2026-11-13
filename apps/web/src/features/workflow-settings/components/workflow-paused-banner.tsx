import { Link } from '@tanstack/react-router';
import type {
  AccessibleWorkspace,
  WorkflowAutoPauseSettings,
} from '@pertexo/contracts';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import { formatDateTime } from '@/lib/format/time';
import { workflowAutoPauseQueryOptions } from '../data/auto-pause.queries';
import { useAutoPauseCommand } from '../data/mutations/use-auto-pause-command';
import { QueryView } from '@/components/patterns/states/query-view';
import { settingsReadFailure } from './settings-read-failure';
import { isAccessLost, shownData } from '@/lib/api/error-copy';
import { cn } from '@/lib/class-names';
import { StatusGlyph } from '@/components/ui/status';
function PausedStateNotice({
  workspaceId,
  settings,
  canResume,
  pending,
  disabled,
  onResume,
}: Readonly<{
  workspaceId: string;
  settings: WorkflowAutoPauseSettings | undefined;
  canResume: boolean;
  pending: boolean;
  disabled: boolean;
  onResume: () => void;
}>) {
  if (settings?.pauseState !== 'paused') return null;
  const time =
    settings.pausedAt === null
      ? '.'
      : ` on ${formatDateTime(settings.pausedAt)}.`;
  return (
    <Notice
      tone="warning"
      title="Schedules and webhooks are paused"
      action={
        canResume ? (
          <ProgressButton
            type="button"
            variant="outline"
            pending={pending}
            pendingLabel="Resuming…"
            disabled={disabled}
            onClick={onResume}
          >
            Resume triggers
          </ProgressButton>
        ) : undefined
      }
    >
      <p>
        Paused after {String(settings.pausedFailures)} failed triggered runs in
        a row{time} Manual runs and replays still work. Resume leaves triggers
        you turned off unchanged.
      </p>
      {settings.pausedLastRunId === null ? null : (
        <p className="mt-1">
          <Link
            to="/w/$workspaceId/runs/$runId"
            params={{ workspaceId, runId: settings.pausedLastRunId }}
            className="inline-link"
          >
            Run that triggered the pause
          </Link>
        </p>
      )}
      {canResume ? null : (
        <p className="mt-1">A workflow editor can resume these triggers.</p>
      )}
    </Notice>
  );
}
/**
 * A failed background read of the pause state, as one quiet line: it
 * doesn't say anything about the person's work, so it floats over the page
 * instead of pushing the canvas or the tab down. Retry keeps its width
 * while it checks, so nothing moves.
 */
function PauseReadProblem({
  checking,
  side,
  onRetry,
}: Readonly<{
  checking: boolean;
  side: 'below' | 'above';
  onRetry: () => void;
}>) {
  return (
    <div className="relative h-0">
      <p
        role="status"
        className={cn(
          // Right-aligned on a phone, clear of the canvas tools on the left;
          // centred from `sm` up.
          'pointer-events-auto absolute right-0 z-20 flex max-w-[calc(100%-7.5rem)] items-center sm:right-auto sm:left-1/2 sm:max-w-[calc(100vw-2rem)] sm:-translate-x-1/2 gap-2 rounded-2xl border border-border bg-card/95 py-1 pr-1.5 pl-2.5 text-xs text-muted-foreground shadow-sm backdrop-blur-sm sm:rounded-full sm:whitespace-nowrap',
          side === 'below' ? 'top-1' : 'bottom-1',
        )}
      >
        <StatusGlyph
          tone={checking ? 'waiting' : 'attention'}
          still={!checking}
          className={cn(
            'max-sm:hidden',
            checking ? 'text-muted-foreground' : 'text-warning',
          )}
        />
        <span className="min-w-0 leading-tight sm:truncate">
          Couldn’t check if triggers are paused.
        </span>
        <button
          type="button"
          className="w-[4.75rem] shrink-0 rounded-full px-1 py-0.5 text-center sm:w-[5.5rem] font-semibold text-foreground focus-ring hover:bg-surface-ink/5 disabled:text-muted-foreground"
          disabled={checking}
          onClick={onRetry}
        >
          {checking ? 'Checking…' : 'Retry'}
        </button>
      </p>
    </div>
  );
}

/** Lost access is the person's problem; any other failure is background. */
function ReadProblem({
  query,
  side,
}: Readonly<{
  query: UseQueryResult<WorkflowAutoPauseSettings>;
  side: 'below' | 'above';
}>) {
  if (query.isError && isAccessLost(query.error))
    return (
      <QueryView
        query={query}
        resource="The workflow pause state"
        failure={settingsReadFailure}
      />
    );
  return (
    <PauseReadProblem
      checking={query.isFetching}
      side={side}
      onRetry={() => void query.refetch()}
    />
  );
}

function ResumeProblem({
  command,
}: Readonly<{ command: ReturnType<typeof useAutoPauseCommand> }>) {
  return command.problem === undefined ? null : (
    <Notice tone="destructive">{command.problem}</Notice>
  );
}
/** Production admission only: this never freezes the editable draft. */
export function WorkflowPausedBanner({
  apiClient,
  userId,
  workspace,
  workflowId,
  showReadError = true,
  problemSide = 'below',
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
  showReadError?: boolean;
  /**
   * Where a failed read's line floats: over the canvas below the editor's
   * bar, or in the top margin above a hub tab.
   */
  problemSide?: 'below' | 'above';
}>) {
  const query = useQuery(
    workflowAutoPauseQueryOptions(apiClient, userId, workspace.id, workflowId),
  );
  const settings = shownData(query);
  const command = useAutoPauseCommand(
    apiClient,
    userId,
    workspace.id,
    workflowId,
  );
  const notifications = useNotifications();
  const canResume = workspace.capabilities.includes('workflow:publish');
  async function resume() {
    let saved = false;
    if (settings !== undefined)
      saved = await command.send({
        kind: 'resume',
        body: { expectedPauseRevision: settings.pauseRevision },
      });
    if (saved)
      notifications.success({
        title: 'Workflow triggers resumed',
        description: 'Triggers you turned off stay off.',
      });
  }
  // A retry of a read that never answered starts over as pending; the line
  // stays, checking, until it gets an answer.
  const readFailed =
    query.isError ||
    (query.isFetching &&
      query.data === undefined &&
      query.errorUpdateCount > 0);
  const nothingToShow =
    (!showReadError || !readFailed) &&
    settings?.pauseState !== 'paused' &&
    command.problem === undefined;
  if (nothingToShow) return null;
  return (
    <div className="pointer-events-auto space-y-2">
      {showReadError && readFailed ? (
        <ReadProblem query={query} side={problemSide} />
      ) : null}
      <PausedStateNotice
        workspaceId={workspace.id}
        settings={settings}
        canResume={canResume}
        pending={command.pending}
        disabled={query.isError}
        onResume={() => void resume()}
      />
      <ResumeProblem command={command} />
    </div>
  );
}
