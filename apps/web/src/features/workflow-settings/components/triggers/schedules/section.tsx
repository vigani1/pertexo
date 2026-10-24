import { ProgressButton } from '@/components/ui/progress-button';
import { DialogClose } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useState } from 'react';
import type { ScheduleTriggerHealthResponse } from '@pertexo/contracts';
import {
  ConfirmDialog,
  ConfirmationFooter,
} from '@/components/patterns/actions/confirm-dialog';
import { Notice } from '@/components/ui/notice';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import { useScheduleCommand } from '../../../data/mutations/use-trigger-commands';
import { ScheduleCard } from './card';
import { ScheduleNextRuns } from './next-runs';
import { ScheduleOccurrences } from './occurrences';

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

  async function setEnabled({
    trigger,
    enabled,
  }: Readonly<{ trigger: ScheduleTriggerHealthResponse; enabled: boolean }>) {
    const done = await schedule.setEnabled({
      triggerId: trigger.id,
      enabled,
      observedEnabled: trigger.status !== 'disabled',
    });
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
            if (enabled) void setEnabled({ trigger, enabled: true });
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
        state={{
          open: pausing !== undefined,
          onOpenChange: (open) => {
            if (!open) setPausing(undefined);
          },
          locked: schedule.pendingTriggerId !== undefined,
        }}
        title="Turn off this schedule?"
        description="No new runs start from it until you turn it back on. Runs already in progress finish normally."
        onSubmit={() =>
          pausing === undefined
            ? undefined
            : setEnabled({ trigger: pausing, enabled: false })
        }
        submitDisabled={schedule.pendingTriggerId !== undefined}
        footer={
          <ConfirmationFooter>
            <DialogClose
              disabled={schedule.pendingTriggerId !== undefined}
              render={<Button type="button" variant="ghost" />}
            >
              Keep it on
            </DialogClose>
            <ProgressButton
              type="submit"
              variant="destructive"
              pending={schedule.pendingTriggerId !== undefined}
              pendingLabel="Turning off…"
            >
              Turn off
            </ProgressButton>
          </ConfirmationFooter>
        }
      ></ConfirmDialog>
    </>
  );
}
