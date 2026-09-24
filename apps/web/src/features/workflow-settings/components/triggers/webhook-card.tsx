import type { ReactNode } from 'react';
import type { WebhookTriggerHealthResponse } from '@pertexo/contracts/schemas/webhooks';
import { KeyRoundIcon, RefreshCwIcon, WebhookIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LoadingOrb } from '@/components/ui/loading-orb';
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
}: Readonly<{
  trigger: WebhookTriggerHealthResponse;
  stepName: string;
  editable: boolean;
  blocked: boolean;
  pendingCommand: WebhookCommand | undefined;
  unresolved: UncertainWebhookCommand | undefined;
  onCommand: (command: WebhookCommand) => void;
  onRetryUnresolved: () => void;
}>) {
  const state = describeTriggerState(trigger);
  return (
    <article
      aria-label={`Webhook: ${stepName}`}
      className="flex flex-col gap-4 rounded-xl border border-border bg-card/50 p-4 sm:p-5"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-md border border-primary/20 bg-primary/8 text-primary">
            <WebhookIcon aria-hidden="true" className="size-4" />
          </span>
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
      {trigger.reconciledAt === null ? null : (
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
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm"
        >
          <p className="text-warning">
            We couldn’t confirm whether {WEBHOOK_ACTIONS[unresolved.command]}{' '}
            went through. Retry that first — it’s safe and won’t repeat the
            change.
          </p>
          <Button
            type="button"
            size="sm"
            disabled={pendingCommand !== undefined}
            onClick={onRetryUnresolved}
          >
            {`Retry ${WEBHOOK_ACTIONS[unresolved.command]}`}
          </Button>
        </div>
      )}
      {editable ? (
        <div className="flex flex-wrap gap-2">
          {trigger.endpointReady ? (
            <>
              <CommandButton
                label="Rotate URL"
                pendingLabel="Rotating…"
                icon={
                  <RefreshCwIcon aria-hidden="true" data-icon="inline-start" />
                }
                pending={pendingCommand === 'rotate-endpoint'}
                disabled={blocked}
                onClick={() => {
                  onCommand('rotate-endpoint');
                }}
              />
              <CommandButton
                label="Rotate secret"
                pendingLabel="Rotating…"
                icon={
                  <KeyRoundIcon aria-hidden="true" data-icon="inline-start" />
                }
                pending={pendingCommand === 'rotate-secret'}
                disabled={blocked}
                onClick={() => {
                  onCommand('rotate-secret');
                }}
              />
            </>
          ) : (
            <CommandButton
              label="Create endpoint"
              pendingLabel="Creating…"
              pending={pendingCommand === 'provision'}
              disabled={blocked}
              onClick={() => {
                onCommand('provision');
              }}
            />
          )}
        </div>
      ) : null}
      <WebhookGuide />
    </article>
  );
}

function CommandButton({
  label,
  pendingLabel,
  icon,
  pending,
  disabled,
  onClick,
}: Readonly<{
  label: string;
  pendingLabel: string;
  icon?: ReactNode;
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
}>) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={onClick}
    >
      {pending ? <LoadingOrb /> : icon}
      {pending ? pendingLabel : label}
    </Button>
  );
}
