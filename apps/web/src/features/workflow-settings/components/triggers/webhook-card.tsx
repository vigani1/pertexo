import type { ReactNode } from 'react';
import type { WebhookTriggerHealthResponse } from '@pertexo/contracts/schemas/webhooks';
import { KeyRoundIcon, RefreshCwIcon } from 'lucide-react';
import { StepTile, describeStep } from '@/features/catalog/presentation.public';
import { Notice } from '@/components/ui/notice';
import { Button } from '@/components/ui/button';
import { ProgressButton } from '@/components/ui/progress-button';
import { Status } from '@/components/ui/status';
import { formatDateTime, formatRelativeTime } from '@/lib/format-time';
import { describeTriggerState } from '../../model/trigger-state';
import {
  WEBHOOK_ACTIONS,
  type UncertainWebhookCommand,
  type WebhookCommand,
} from '../../mutations/use-trigger-commands';
import { WebhookGuide } from './webhook-guide';

/** One webhook trigger: its health, its endpoint and the commands for it. */
export function WebhookCard({
  trigger,
  stepName,
  editable,
  blocked,
  pendingCommand,
  unresolved,
  onCommand,
  onRetryUnresolved,
  failure,
  deliveries,
}: Readonly<{
  trigger: WebhookTriggerHealthResponse;
  stepName: string;
  editable: boolean;
  blocked: boolean;
  pendingCommand: WebhookCommand | undefined;
  unresolved: UncertainWebhookCommand | undefined;
  onCommand: (command: WebhookCommand) => void;
  onRetryUnresolved: () => void;
  /** Why the last command on this webhook failed, shown by its buttons. */
  failure?: string | undefined;
  /** The recent delivery log, composed by the section that can read it. */
  deliveries?: ReactNode;
}>) {
  const state = describeTriggerState(trigger);
  return (
    <article
      aria-label={`Webhook: ${stepName}`}
      className="flex flex-col gap-4 rounded-xl border border-border bg-card/50 p-4 sm:p-5"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <StepTile step={describeStep('core.webhook')} size="lg" />
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold">{stepName}</h3>
            <p className="text-xs text-muted-foreground">
              {trigger.endpointReady
                ? 'Endpoint ready. Senders post JSON to its address.'
                : 'No endpoint yet. Create one to get an address and a signing secret.'}
            </p>
          </div>
        </div>
        <Status tone={state.tone}>{state.label}</Status>
      </header>
      {/* Checking only means something once there's an endpoint. */}
      {trigger.reconciledAt === null || !trigger.endpointReady ? null : (
        <p className="font-mono text-[0.72rem] text-subtle-foreground">
          Last checked{' '}
          <time
            dateTime={trigger.reconciledAt}
            title={formatDateTime(trigger.reconciledAt)}
          >
            {formatRelativeTime(trigger.reconciledAt)}
          </time>
        </p>
      )}
      {unresolved === undefined ? null : (
        <Notice
          role="alert"
          tone="warning"
          action={
            <Button
              type="button"
              size="sm"
              disabled={pendingCommand !== undefined}
              onClick={onRetryUnresolved}
            >
              {`Retry ${WEBHOOK_ACTIONS[unresolved.command]}`}
            </Button>
          }
        >
          We couldn’t confirm whether {WEBHOOK_ACTIONS[unresolved.command]} went
          through. Retry that first — it’s safe and won’t repeat the change.
        </Notice>
      )}
      {editable ? (
        <div className="flex flex-wrap gap-2">
          {trigger.endpointReady ? (
            <>
              <ProgressButton
                type="button"
                variant="outline"
                size="sm"
                pendingLabel="Rotating…"
                icon={
                  <RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
                }
                pending={pendingCommand === 'rotate-endpoint'}
                disabled={blocked}
                onClick={() => {
                  onCommand('rotate-endpoint');
                }}
              >
                Rotate URL
              </ProgressButton>
              <ProgressButton
                type="button"
                variant="outline"
                size="sm"
                pendingLabel="Rotating…"
                icon={
                  <KeyRoundIcon aria-hidden="true" data-icon="inline-start" />
                }
                pending={pendingCommand === 'rotate-secret'}
                disabled={blocked}
                onClick={() => {
                  onCommand('rotate-secret');
                }}
              >
                Rotate secret
              </ProgressButton>
            </>
          ) : (
            <ProgressButton
              type="button"
              variant="outline"
              size="sm"
              pendingLabel="Creating…"
              pending={pendingCommand === 'provision'}
              disabled={blocked}
              onClick={() => {
                onCommand('provision');
              }}
            >
              Create endpoint
            </ProgressButton>
          )}
        </div>
      ) : null}
      {failure === undefined ? null : (
        <Notice role="alert" tone="destructive">
          {failure}
        </Notice>
      )}
      {deliveries}
      <WebhookGuide />
    </article>
  );
}
