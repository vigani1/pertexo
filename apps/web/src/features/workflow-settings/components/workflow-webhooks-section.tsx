import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { ApiClient } from '@/lib/api/client';
import { useWebhookCommand } from '../mutations/use-trigger-commands';
import type { WorkflowSettingsWebhooks } from '../workflow-settings.api';
import {
  SettingsQueryState,
  SettingsSection,
  type SettingsQuery,
} from './settings-section';
import { visibleSettingsData } from './settings-query';

export function WorkflowWebhooksSection({
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
  query: SettingsQuery<WorkflowSettingsWebhooks>;
}>) {
  const [endpointKeys, setEndpointKeys] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const editable = workspace.capabilities.includes('workflow:update');
  const webhookCommand = useWebhookCommand({
    apiClient,
    userId,
    workspaceId: workspace.id,
    workflowId,
  });
  const data = visibleSettingsData(query);

  async function run(
    triggerId: string,
    command: 'provision' | 'rotate-endpoint' | 'rotate-secret',
  ) {
    const outcome = await webhookCommand.execute(
      triggerId,
      command,
      endpointKeys.get(triggerId) ?? '',
    );
    if (outcome !== 'failed' && outcome !== 'blocked') {
      setEndpointKeys((current) => {
        const next = new Map(current);
        next.delete(triggerId);
        return next;
      });
    }
  }

  function acknowledgeCredentials() {
    webhookCommand.acknowledgeCredentials();
  }

  async function retryUncertain() {
    const triggerId = webhookCommand.unresolvedAttempt?.triggerId;
    const outcome = await webhookCommand.retryUncertain();
    if (
      triggerId !== undefined &&
      outcome !== 'failed' &&
      outcome !== 'blocked'
    ) {
      setEndpointKeys((current) => {
        const next = new Map(current);
        next.delete(triggerId);
        return next;
      });
    }
  }

  return (
    <SettingsSection
      id="workflow-webhooks"
      title="Webhooks"
      description="Provision and rotate published webhook endpoints. Newly issued credentials are shown once."
    >
      <SettingsQueryState query={query} />
      {data !== undefined && webhookCommand.error ? (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {webhookCommand.error}
        </p>
      ) : null}
      {data !== undefined && webhookCommand.unresolvedAttempt ? (
        <div className="mb-3 rounded-lg border border-secondary/30 bg-secondary/5 p-3">
          <p className="text-sm text-muted-foreground">
            The original{' '}
            {webhookCommand.unresolvedAttempt.command.replaceAll('-', ' ')}{' '}
            result is still uncertain. Retry that exact command before issuing
            another webhook command.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-3"
            disabled={webhookCommand.pendingTriggerId !== undefined}
            onClick={() => void retryUncertain()}
          >
            {`Retry ${webhookRetryLabel(webhookCommand.unresolvedAttempt.command)} safely`}
          </Button>
        </div>
      ) : null}
      {data?.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No published webhook trigger exists.
        </p>
      ) : null}
      <ul className="divide-y">
        {data?.items.map((trigger) => {
          const endpointKey = endpointKeys.get(trigger.id) ?? '';
          return (
            <li key={trigger.id} className="space-y-3 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-medium">Node {trigger.nodeId}</p>
                  <p className="text-sm text-muted-foreground">
                    {trigger.endpointReady
                      ? 'Endpoint ready'
                      : 'Provisioning required'}
                  </p>
                </div>
                <Badge
                  variant={
                    trigger.healthStatus === 'healthy' ? 'muted' : 'secondary'
                  }
                >
                  {trigger.healthStatus}
                </Badge>
              </div>
              {editable ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={webhookCommand.blocked}
                    onClick={() =>
                      void run(
                        trigger.id,
                        trigger.endpointReady ? 'rotate-endpoint' : 'provision',
                      )
                    }
                  >
                    {webhookCommand.pendingTriggerId === trigger.id
                      ? 'Updating…'
                      : trigger.endpointReady
                        ? 'Rotate endpoint'
                        : 'Provision endpoint'}
                  </Button>
                  <Input
                    aria-label={`Endpoint key for ${trigger.nodeId}`}
                    name={`endpointKey-${trigger.id}`}
                    type="password"
                    autoComplete="off"
                    placeholder="Current endpoint key"
                    className="max-w-xs"
                    value={endpointKey}
                    onChange={(event) => {
                      const next = new Map(endpointKeys);
                      next.set(trigger.id, event.target.value);
                      setEndpointKeys(next);
                    }}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={
                      webhookCommand.blocked || endpointKey.trim() === ''
                    }
                    onClick={() => void run(trigger.id, 'rotate-secret')}
                  >
                    Rotate signing secret
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <Dialog
        open={data !== undefined && webhookCommand.credentials !== undefined}
        onOpenChange={(open) => {
          if (!open) acknowledgeCredentials();
        }}
      >
        <DialogContent>
          <DialogTitle>Store webhook credentials now</DialogTitle>
          <DialogDescription>
            Credentials for trigger {webhookCommand.credentials?.triggerId} are
            returned only for this successful command. They are not retained in
            browser storage and cannot be shown again after closing.
          </DialogDescription>
          <dl className="mt-5 space-y-3">
            {webhookCommand.credentials?.response.endpointKey ? (
              <Secret
                label="Endpoint key"
                value={webhookCommand.credentials.response.endpointKey}
              />
            ) : null}
            {webhookCommand.credentials?.response.signingSecret ? (
              <Secret
                label="Signing secret"
                value={webhookCommand.credentials.response.signingSecret}
              />
            ) : null}
          </dl>
          <div className="mt-6 flex justify-end">
            <DialogClose render={<Button type="button" />}>
              I stored them
            </DialogClose>
          </div>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}

function webhookRetryLabel(
  command: 'provision' | 'rotate-endpoint' | 'rotate-secret',
): string {
  if (command === 'provision') return 'provisioning';
  if (command === 'rotate-endpoint') return 'endpoint rotation';
  return 'secret rotation';
}

function Secret({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-all rounded-lg border bg-background/60 p-3 font-mono text-sm">
        {value}
      </dd>
    </div>
  );
}
