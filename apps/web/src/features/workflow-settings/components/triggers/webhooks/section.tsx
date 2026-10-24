import { WebhookAuthenticationDialog } from './authentication-dialog';
import { useState } from 'react';
import type {
  WebhookTriggerHealthResponse,
  WebhookAuthentication,
} from '@pertexo/contracts';
import { ConfirmDialog } from '@/components/patterns/actions/confirm-dialog';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import {
  useWebhookCommand,
  type WebhookCommand,
} from '../../../data/mutations/use-trigger-commands';
import { RotateSecretDialog } from './rotate-secret-dialog';
import { SecretRevealDialog } from './secret-reveal-dialog';
import { WebhookCard } from './card';
import { WebhookDeliveries } from './deliveries';

const DONE: Readonly<Record<WebhookCommand, string>> = {
  provision: 'Endpoint created',
  authentication: 'Authentication updated',
  'rotate-endpoint': 'URL rotated',
  'rotate-secret': 'Webhook secret rotated',
};

/**
 * Webhook cards and their commands. Only one command runs at a time, new
 * credentials must be acknowledged before the next, and an unconfirmed
 * command must be retried exactly before anything else is sent.
 */
type WebhooksSectionProps = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  workflowId: string;
  editable: boolean;
  triggers: readonly WebhookTriggerHealthResponse[];
  stepNameFor: (trigger: WebhookTriggerHealthResponse) => string;
}>;

export function WebhooksSection(props: WebhooksSectionProps) {
  const model = useWebhookActions(props);
  const configuring = model.configuring;
  return (
    <>
      {model.triggers.map((trigger) => (
        <WebhookCard
          key={trigger.id}
          trigger={trigger}
          stepName={model.stepNameFor(trigger)}
          editable={model.editable}
          blocked={model.webhook.blocked}
          pendingCommand={
            model.webhook.pending?.triggerId === trigger.id
              ? model.webhook.pending.command
              : undefined
          }
          unresolved={
            model.webhook.unresolvedAttempt?.triggerId === trigger.id
              ? model.webhook.unresolvedAttempt
              : undefined
          }
          onCommand={(command) => {
            if (command === 'authentication') model.setConfiguring(trigger);
            else if (command === 'provision')
              void model.run(trigger.id, command);
            else model.setConfirming({ triggerId: trigger.id, command });
          }}
          onRetryUnresolved={() => void model.retry()}
          failure={
            model.webhook.error?.triggerId === trigger.id
              ? model.webhook.error.message
              : undefined
          }
          deliveries={
            <WebhookDeliveries
              apiClient={model.apiClient}
              userId={model.userId}
              workspaceId={model.workspaceId}
              workflowId={model.workflowId}
              triggerId={trigger.id}
              endpointReady={trigger.endpointReady}
            />
          }
        />
      ))}
      {configuring === undefined ? null : (
        <WebhookAuthenticationDialog
          key={configuring.id}
          authentication={configuring.authentication}
          pending={model.webhook.pending?.command === 'authentication'}
          blocked={model.webhook.blocked}
          error={
            model.webhook.error?.triggerId === configuring.id
              ? model.webhook.error.message
              : undefined
          }
          onSave={(authentication) =>
            model.run(configuring.id, 'authentication', '', authentication)
          }
          onClose={() => {
            model.setConfiguring(undefined);
          }}
        />
      )}
      <ConfirmDialog
        open={model.confirming?.command === 'rotate-endpoint'}
        onOpenChange={(open) => {
          if (!open) model.setConfirming(undefined);
        }}
        title="Rotate this webhook’s URL?"
        description="Senders using the current address stop being accepted right away. You’ll get a new endpoint key to give them."
        tone="destructive"
        confirmLabel="Rotate URL"
        pendingLabel="Rotating…"
        pending={model.webhook.pending?.command === 'rotate-endpoint'}
        onConfirm={() =>
          model.confirming === undefined
            ? undefined
            : model.run(model.confirming.triggerId, 'rotate-endpoint')
        }
      />
      <RotateSecretDialog
        open={model.confirming?.command === 'rotate-secret'}
        headerSecret={
          model.triggers.find(
            (trigger) => trigger.id === model.confirming?.triggerId,
          )?.authentication.mode === 'header_secret'
        }
        pending={model.webhook.pending?.command === 'rotate-secret'}
        onRotate={(endpointKey) =>
          model.confirming === undefined
            ? Promise.resolve()
            : model.run(
                model.confirming.triggerId,
                'rotate-secret',
                endpointKey,
              )
        }
        onClose={() => {
          model.setConfirming(undefined);
        }}
      />
      <SecretRevealDialog
        credentials={model.webhook.credentials?.response}
        onDone={() => {
          const command = model.webhook.credentials?.command;
          model.webhook.acknowledgeCredentials();
          if (command !== undefined)
            model.notifications.success({ title: DONE[command] });
        }}
      />
    </>
  );
}

function useWebhookActions({
  apiClient,
  userId,
  workspaceId,
  workflowId,
  editable,
  triggers,
  stepNameFor,
}: WebhooksSectionProps) {
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

  const [configuring, setConfiguring] =
    useState<WebhookTriggerHealthResponse>();

  async function run(
    triggerId: string,
    command: WebhookCommand,
    key = '',
    authentication?: WebhookAuthentication,
  ) {
    const outcome = await webhook.execute(
      triggerId,
      command,
      key,
      authentication,
    );
    setConfirming(undefined);
    if (outcome !== 'failed' && outcome !== 'blocked')
      setConfiguring(undefined);
    if (outcome === 'updated') notifications.success({ title: DONE[command] });
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

  return {
    triggers,
    stepNameFor,
    editable,
    webhook,
    setConfiguring,
    run,
    setConfirming,
    retry,
    apiClient,
    userId,
    workspaceId,
    workflowId,
    configuring,
    confirming,
    notifications,
  } as const;
}
