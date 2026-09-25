import { useState } from 'react';
import type { WebhookTriggerHealthResponse } from '@pertexo/contracts/schemas/webhooks';
import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import { Notice } from '@/components/ui/notice';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import {
  useWebhookCommand,
  type WebhookCommand,
} from '../../mutations/use-trigger-commands';
import { RotateSecretDialog } from './rotate-secret-dialog';
import { SecretRevealDialog } from './secret-reveal-dialog';
import { WebhookCard } from './webhook-card';
import { WebhookDeliveries } from './webhook-deliveries';

const DONE: Readonly<Record<WebhookCommand, string>> = {
  provision: 'Endpoint created',
  'rotate-endpoint': 'URL rotated',
  'rotate-secret': 'Signing secret rotated',
};

/**
 * Webhook cards and their commands. Only one command runs at a time, new
 * credentials must be acknowledged before the next, and an unconfirmed
 * command must be retried exactly before anything else is sent.
 */
export function WebhooksSection({
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
  triggers: readonly WebhookTriggerHealthResponse[];
  stepNameFor: (trigger: WebhookTriggerHealthResponse) => string;
}>) {
  const notifications = useNotifications();
  const webhook = useWebhookCommand({
    apiClient,
    userId,
    workspaceId,
    workflowId,
  });
  const [confirming, setConfirming] = useState<
    Readonly<{
      triggerId: string;
      command: 'rotate-endpoint' | 'rotate-secret';
    }>
  >();

  async function run(triggerId: string, command: WebhookCommand, key = '') {
    const outcome = await webhook.execute(triggerId, command, key);
    setConfirming(undefined);
    if (outcome === 'complete')
      notifications.info({
        title: 'That change was already made',
        description:
          'Its credentials were shown the first time. Rotate again if they weren’t stored.',
      });
  }

  async function retry() {
    const outcome = await webhook.retryUncertain();
    if (outcome === 'complete')
      notifications.success({ title: 'Confirmed — the change went through' });
  }

  return (
    <>
      {webhook.error === undefined ? null : (
        <Notice tone="destructive">{webhook.error}</Notice>
      )}
      {triggers.map((trigger) => (
        <WebhookCard
          key={trigger.id}
          trigger={trigger}
          stepName={stepNameFor(trigger)}
          editable={editable}
          blocked={webhook.blocked}
          pendingCommand={
            webhook.pending?.triggerId === trigger.id
              ? webhook.pending.command
              : undefined
          }
          unresolved={
            webhook.unresolvedAttempt?.triggerId === trigger.id
              ? webhook.unresolvedAttempt
              : undefined
          }
          onCommand={(command) => {
            if (command === 'provision') void run(trigger.id, command);
            else setConfirming({ triggerId: trigger.id, command });
          }}
          onRetryUnresolved={() => void retry()}
          deliveries={
            <WebhookDeliveries
              apiClient={apiClient}
              userId={userId}
              workspaceId={workspaceId}
              workflowId={workflowId}
              triggerId={trigger.id}
              endpointReady={trigger.endpointReady}
            />
          }
        />
      ))}
      <ConfirmDialog
        open={confirming?.command === 'rotate-endpoint'}
        onOpenChange={(open) => {
          if (!open) setConfirming(undefined);
        }}
        title="Rotate this webhook’s URL?"
        description="Senders using the current address stop being accepted right away. You’ll get a new endpoint key to give them."
        tone="destructive"
        confirmLabel="Rotate URL"
        pendingLabel="Rotating…"
        pending={webhook.pending?.command === 'rotate-endpoint'}
        onConfirm={() =>
          confirming === undefined
            ? undefined
            : run(confirming.triggerId, 'rotate-endpoint')
        }
      />
      <RotateSecretDialog
        open={confirming?.command === 'rotate-secret'}
        pending={webhook.pending?.command === 'rotate-secret'}
        onRotate={(endpointKey) =>
          confirming === undefined
            ? Promise.resolve()
            : run(confirming.triggerId, 'rotate-secret', endpointKey)
        }
        onClose={() => {
          setConfirming(undefined);
        }}
      />
      <SecretRevealDialog
        credentials={webhook.credentials?.response}
        onDone={() => {
          const command = webhook.credentials?.command;
          webhook.acknowledgeCredentials();
          if (command !== undefined)
            notifications.success({ title: DONE[command] });
        }}
      />
    </>
  );
}
