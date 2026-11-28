import type { AccessibleWorkspace, WorkflowSummary } from '@pertexo/contracts';
import { useQuery } from '@tanstack/react-query';
import { SettingRow, SettingsGroup } from '@/components/patterns/settings/row';
import { StatusMark } from '@/components/patterns/status/status-mark';
import { Notice } from '@/components/patterns/notices/inline-notice';
import { shownData } from '@/lib/api/error-copy';
import { QueryView } from '@/components/patterns/states/query-view';
import { useNotifications } from '@/components/ui/use-notifications';
import { ProgressButton } from '@/components/ui/progress-button';
import type { ApiClient } from '@/lib/api/client';
import { workflowAutoPauseQueryOptions } from '../data/auto-pause.queries';
import { useAutoPauseCommand } from '../data/mutations/use-auto-pause-command';
import { settingsReadFailure } from './settings-read-failure';

export function TriggerPauseRow({
  apiClient,
  userId,
  workspace,
  workflow,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflow: WorkflowSummary;
}>) {
  const query = useQuery(
    workflowAutoPauseQueryOptions(apiClient, userId, workspace.id, workflow.id),
  );
  const command = useAutoPauseCommand(apiClient, userId, workspace.id);
  const notifications = useNotifications();
  const canPublish =
    workspace.status === 'active' &&
    workspace.capabilities.includes('workflow:publish') &&
    (workflow.resourceAccess?.canPublish ?? true);
  async function changePause(paused: boolean, expectedPauseRevision: string) {
    const saved = await command.send({
      kind: paused ? 'resume' : 'pause',
      workflowId: workflow.id,
      body: { expectedPauseRevision },
    });
    if (saved)
      notifications.success({
        title: paused
          ? 'Workflow triggers resumed'
          : 'Workflow triggers paused',
      });
  }
  if (
    workflow.publishedVersionId === null &&
    shownData(query)?.pauseState !== 'paused'
  )
    return null;
  return (
    <SettingsGroup title="Workflow state">
      <QueryView
        query={query}
        resource="Trigger state"
        failure={settingsReadFailure}
      >
        {(settings) => {
          const paused = settings.pauseState === 'paused';
          return (
            <>
              <SettingRow
                title="Trigger state"
                description={
                  <StatusMark tone={paused ? 'waiting' : 'success'}>
                    {paused ? 'Paused' : 'Unpaused'}
                  </StatusMark>
                }
                action={
                  canPublish ? (
                    <ProgressButton
                      type="button"
                      variant="outline"
                      pending={command.pending}
                      pendingLabel={paused ? 'Resuming…' : 'Pausing…'}
                      disabled={query.isError}
                      onClick={() =>
                        void changePause(paused, settings.pauseRevision)
                      }
                    >
                      {paused ? 'Resume triggers' : 'Pause triggers'}
                    </ProgressButton>
                  ) : undefined
                }
              />
              {command.problem === undefined ? null : (
                <Notice tone="destructive">{command.problem}</Notice>
              )}
            </>
          );
        }}
      </QueryView>
    </SettingsGroup>
  );
}
