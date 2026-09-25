import { useState } from 'react';
import type { ScheduleTriggerHealthResponse } from '@pertexo/contracts/schemas/schedules';
import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import { Notice } from '@/components/ui/notice';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import { useScheduleCommand } from '../../mutations/use-trigger-commands';
import { ScheduleCard } from './schedule-card';
import { ScheduleNextRuns } from './schedule-next-runs';
import { ScheduleOccurrences } from './schedule-occurrences';

/**
 * Schedule cards with their next and recent runs. Turning one on is
 * immediate; turning one off asks first, because nothing runs from it until
 * someone turns it back on.
 */
export function SchedulesSection({
  apiClient,
  userId,
  workspaceId,
  workflowId,
  editable,
  triggers,
  stepNameFor,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  editable: boolean;
  triggers: readonly ScheduleTriggerHealthResponse[];
  stepNameFor: (trigger: ScheduleTriggerHealthResponse) => string;
}>) {
  const notifications = useNotifications();
  const schedule = useScheduleCommand({
    apiClient,
    userId,
    workspaceId,
    workflowId,
  });
  const [pausing, setPausing] = useState<ScheduleTriggerHealthResponse>();

  async function setEnabled(
    trigger: ScheduleTriggerHealthResponse,
    enabled: boolean,
  ) {
    const done = await schedule.setEnabled(
      trigger.id,
      enabled,
      trigger.status !== 'disabled',
    );
    setPausing(undefined);
    if (done)
      notifications.success({
        title: enabled ? 'Schedule turned on' : 'Schedule turned off',
        description: stepNameFor(trigger),
      });
  }

  return (
    <>
      {schedule.error === undefined ? null : (
        <Notice tone="destructive">{schedule.error}</Notice>
      )}
      {triggers.map((trigger) => (
        <ScheduleCard
          key={trigger.id}
          trigger={trigger}
          stepName={stepNameFor(trigger)}
          editable={editable}
          pending={schedule.pendingTriggerId === trigger.id}
          disabled={schedule.pendingTriggerId !== undefined}
          onEnabledChange={(enabled) => {
            if (enabled) void setEnabled(trigger, true);
            else setPausing(trigger);
          }}
          nextRuns={
            <ScheduleNextRuns
              apiClient={apiClient}
              userId={userId}
              workspaceId={workspaceId}
              workflowId={workflowId}
              trigger={trigger}
            />
          }
          history={
            <ScheduleOccurrences
              apiClient={apiClient}
              userId={userId}
              workspaceId={workspaceId}
              workflowId={workflowId}
              triggerId={trigger.id}
            />
          }
        />
      ))}
      <ConfirmDialog
        open={pausing !== undefined}
        onOpenChange={(open) => {
          if (!open) setPausing(undefined);
        }}
        title="Turn off this schedule?"
        description="No new runs start from it until you turn it back on. Runs already in progress finish normally."
        tone="destructive"
        confirmLabel="Turn off"
        pendingLabel="Turning off…"
        cancelLabel="Keep it on"
        pending={schedule.pendingTriggerId !== undefined}
        onConfirm={() =>
          pausing === undefined ? undefined : setEnabled(pausing, false)
        }
      />
    </>
  );
}
