import type {
  AccessibleWorkspace,
  WorkflowAutoPauseSettings,
} from '@pertexo/contracts';
import { useQuery } from '@tanstack/react-query';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import { formatDateTime } from '@/lib/format/time';
import { workflowAutoPauseQueryOptions } from '../data/auto-pause.queries';
import { useAutoPauseCommand } from '../data/mutations/use-auto-pause-command';
import { visibleSettingsData } from '../model/settings-query';
import { SettingsQueryState } from './settings-query-state';

function PausedStateNotice({
  settings,
  canResume,
  pending,
  disabled,
  onResume,
}: Readonly<{
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
      {canResume ? null : (
        <p className="mt-1">A workflow editor can resume these triggers.</p>
      )}
    </Notice>
  );
}

function ResumeProblem({
  command,
  canResume,
  onRetry,
}: Readonly<{
  command: ReturnType<typeof useAutoPauseCommand>;
  canResume: boolean;
  onRetry: () => void;
}>) {
  if (command.problem === undefined) return null;
  return (
    <Notice
      tone={command.unconfirmed ? 'warning' : 'destructive'}
      action={
        command.unconfirmed && canResume ? (
          <ProgressButton
            type="button"
            variant="outline"
            pending={command.pending}
            pendingLabel="Resuming…"
            onClick={onRetry}
          >
            Retry Resume
          </ProgressButton>
        ) : undefined
      }
    >
      {command.problem}
    </Notice>
  );
}

/** Production admission only: this never freezes the editable draft. */
export function WorkflowPausedBanner({
  apiClient,
  userId,
  workspace,
  workflowId,
  showReadError = true,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
  showReadError?: boolean;
}>) {
  const query = useQuery(
    workflowAutoPauseQueryOptions(apiClient, userId, workspace.id, workflowId),
  );
  const settings = visibleSettingsData(query);
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
    if (command.unconfirmed) saved = await command.retry();
    else if (settings !== undefined)
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
  if (
    (!showReadError || !query.isError) &&
    settings?.pauseState !== 'paused' &&
    command.problem === undefined
  )
    return null;
  return (
    <div className="pointer-events-auto space-y-2">
      {showReadError && query.isError ? (
        <SettingsQueryState query={query} resource="The workflow pause state" />
      ) : null}
      <PausedStateNotice
        settings={settings}
        canResume={canResume}
        pending={command.pending}
        disabled={query.isError || command.unconfirmed}
        onResume={() => void resume()}
      />
      <ResumeProblem
        command={command}
        canResume={canResume}
        onRetry={() => void resume()}
      />
    </div>
  );
}
