import type { ReactNode } from 'react';
import type { WebhookTriggerHealthResponse } from '@pertexo/contracts';
import { KeyRoundIcon, RefreshCwIcon } from 'lucide-react';
import { StepTile } from '@/features/catalog/catalog-views.public';
import { describeStep } from '@/features/catalog/public';
import { Notice } from '@/components/patterns/notices/inline-notice';
import { Button } from '@/components/ui/button';
import { ProgressButton } from '@/components/ui/progress-button';
import { StatusMark } from '@/components/patterns/status/status-mark';
import { formatDateTime, formatRelativeTime } from '@/lib/format/time';
import {
  describeTriggerRepair,
  describeTriggerState,
} from '../../../model/triggers/trigger-state';
import {
  WEBHOOK_ACTIONS,
  type UncertainWebhookCommand,
  type WebhookCommand,
} from '../../../data/mutations/use-trigger-commands';
import { WebhookGuide } from './guide';
import { TriggerRow } from '../trigger-row';

/** One webhook trigger: its health, its endpoint and the commands for it. */
type WebhookCardProps = Readonly<{
  trigger: WebhookTriggerHealthResponse;
  stepName: string;
  editable: boolean;
  blocked: boolean;
  /** The recent delivery log, composed by the section that can read it. */
  deliveries?: ReactNode;
  command: Readonly<{
    pendingCommand: WebhookCommand | undefined;
    unresolved: UncertainWebhookCommand | undefined;
    onCommand: (command: WebhookCommand) => void;
    onRetryUnresolved: () => void;
    /** Why the last command on this webhook failed, shown by its buttons. */
    failure?: string | undefined;
  }>;
}>;

export function WebhookCard({
  trigger,
  stepName,
  editable,
  blocked,
  deliveries,
  command,
}: WebhookCardProps) {
  const { pendingCommand, unresolved, onCommand, onRetryUnresolved, failure } =
    command;

  const state = describeTriggerState(trigger);
  const repair = describeTriggerRepair(trigger);
  return (
    <TriggerRow
      label={`Webhook: ${stepName}`}
      icon={<StepTile step={describeStep('core.webhook')} />}
      name={stepName}
      kind={`Webhook · ${authenticationLabel(trigger.authentication)}`}
      extra={
        <>
          {trigger.endpointReady ? null : (
            <p className="text-meta text-subtle-foreground">
              No endpoint yet. Create one to get an address and a signing
              secret.
            </p>
          )}
          {repair === undefined ? null : (
            <Notice tone="warning" className="mt-2">
              {repair}
            </Notice>
          )}
        </>
      }
      state={
        <>
          <StatusMark tone={state.tone}>{state.label}</StatusMark>
          {/* Checking only means something once there's an endpoint. */}
          {trigger.reconciledAt === null || !trigger.endpointReady ? null : (
            <span className="text-meta text-subtle-foreground">
              Checked{' '}
              <time
                dateTime={trigger.reconciledAt}
                title={formatDateTime(trigger.reconciledAt)}
              >
                {formatRelativeTime(trigger.reconciledAt)}
              </time>
            </span>
          )}
        </>
      }
      control={
        editable && trigger.endpointReady ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={blocked}
            onClick={() => {
              onCommand('authentication');
            }}
          >
            Edit
          </Button>
        ) : null
      }
      details={
        <>
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
              We couldn’t confirm whether {WEBHOOK_ACTIONS[unresolved.command]}{' '}
              went through. Retry that first — it’s safe and won’t repeat the
              change.
            </Notice>
          )}
          {editable ? (
            <WebhookActions
              trigger={trigger}
              blocked={blocked}
              pendingCommand={pendingCommand}
              onCommand={onCommand}
            />
          ) : null}
          {failure === undefined ? null : (
            <Notice role="alert" tone="destructive">
              {failure}
            </Notice>
          )}
          {deliveries}
          <WebhookGuide authentication={trigger.authentication} />
        </>
      }
    />
  );
}

function WebhookActions({
  trigger,
  blocked,
  pendingCommand,
  onCommand,
}: Readonly<{
  trigger: WebhookTriggerHealthResponse;
  blocked: boolean;
  pendingCommand: WebhookCommand | undefined;
  onCommand: (command: WebhookCommand) => void;
}>) {
  if (!trigger.endpointReady)
    return (
      <ProgressButton
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        pendingLabel="Creating…"
        pending={pendingCommand === 'provision'}
        disabled={blocked}
        onClick={() => {
          onCommand('provision');
        }}
      >
        Create endpoint
      </ProgressButton>
    );
  return (
    <div className="flex flex-wrap gap-2">
      <ProgressButton
        type="button"
        variant="outline"
        size="sm"
        pendingLabel="Rotating…"
        icon={<RefreshCwIcon aria-hidden="true" data-icon="inline-start" />}
        pending={pendingCommand === 'rotate-endpoint'}
        disabled={blocked}
        onClick={() => {
          onCommand('rotate-endpoint');
        }}
      >
        Rotate URL
      </ProgressButton>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={blocked}
        onClick={() => {
          onCommand('authentication');
        }}
      >
        Authentication…
      </Button>
      {trigger.authentication.mode === 'secret_url' ? null : (
        <ProgressButton
          type="button"
          variant="outline"
          size="sm"
          pendingLabel="Rotating…"
          icon={<KeyRoundIcon aria-hidden="true" data-icon="inline-start" />}
          pending={pendingCommand === 'rotate-secret'}
          disabled={blocked}
          onClick={() => {
            onCommand('rotate-secret');
          }}
        >
          Rotate secret
        </ProgressButton>
      )}
    </div>
  );
}

function authenticationLabel(
  authentication: WebhookTriggerHealthResponse['authentication'],
): string {
  if (authentication.mode === 'signed') return 'signed requests';
  if (authentication.mode === 'secret_url') return 'secret address';
  return `header secret (${authentication.headerName})`;
}
