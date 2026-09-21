import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { ApiClient } from '@/lib/api/client';
import { useScheduleCommand } from '../mutations/use-trigger-commands';
import type { WorkflowSettingsSchedules } from '../workflow-settings.api';
import {
  SettingsQueryState,
  SettingsSection,
  type SettingsQuery,
} from './settings-section';
import { visibleSettingsData } from './settings-query';

const settingsDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function WorkflowSchedulesSection({
  apiClient,
  userId,
  workspace,
  workflowId,
  query,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
  query: SettingsQuery<WorkflowSettingsSchedules>;
}>) {
  const editable = workspace.capabilities.includes('workflow:update');
  const scheduleCommand = useScheduleCommand({
    apiClient,
    userId,
    workspaceId: workspace.id,
    workflowId,
  });
  const data = visibleSettingsData(query);

  return (
    <SettingsSection
      id="workflow-schedules"
      title="Schedules"
      description="Controls are derived from schedule nodes in the published workflow version."
    >
      <SettingsQueryState query={query} />
      {data !== undefined && scheduleCommand.error ? (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {scheduleCommand.error}
        </p>
      ) : null}
      {data?.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No published schedule trigger exists.
        </p>
      ) : null}
      <ul className="divide-y">
        {data?.items.map((trigger) => (
          <li
            key={trigger.id}
            className="flex flex-wrap items-center justify-between gap-3 py-3"
          >
            <div>
              <p className="font-medium">
                {trigger.recurrence.kind === 'cron'
                  ? `${trigger.recurrence.expression} · ${trigger.recurrence.timezone}`
                  : `Every ${String(trigger.recurrence.intervalMinutes)} minutes`}
              </p>
              <p className="text-sm text-muted-foreground">
                Next{' '}
                {settingsDateFormatter.format(new Date(trigger.nextFireAt))}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant={
                  trigger.healthStatus === 'healthy' ? 'muted' : 'secondary'
                }
              >
                {trigger.healthStatus}
              </Badge>
              {editable ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={scheduleCommand.pendingTriggerId !== undefined}
                  onClick={() =>
                    void scheduleCommand.setEnabled(
                      trigger.id,
                      trigger.status === 'disabled',
                      trigger.status !== 'disabled',
                    )
                  }
                >
                  {scheduleCommand.pendingTriggerId === trigger.id
                    ? 'Updating…'
                    : trigger.status === 'disabled'
                      ? 'Enable'
                      : 'Disable'}
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </SettingsSection>
  );
}
