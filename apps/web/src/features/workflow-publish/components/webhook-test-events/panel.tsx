import { QueryView } from '@/components/patterns/states/query-view';
import {
  webhookListenerState,
  WEBHOOK_LISTENER_STATUS,
} from '../../model/testing/webhook-listener';
import { useEffect, useRef } from 'react';
import { Notice } from '@/components/ui/notice';
import { Status } from '@/components/ui/status';
import { ProgressButton } from '@/components/ui/progress-button';
import { useListenerClock } from './use-clock';
import type { SampleScope } from '../../data/samples/api';
import { useWebhookListener } from './use-listener';
import { ListenerAuthentication } from './authentication';
import { ListenerCredentials } from './credentials';
import { CapturedEvent } from './capture';

export function WebhookTestEventPanel({
  scope,
  active = true,
  nodeId,
  binding,
  ensureSaved,
}: {
  scope: SampleScope;
  active?: boolean;
  nodeId: string;
  binding: string | undefined;
  ensureSaved: () => Promise<{ revision: number }>;
}) {
  const test = useWebhookListener({
    scope,
    nodeId,
    binding,
    ensureSaved,
    active,
  });
  const { listener, query } = test;
  const heading = useRef<HTMLHeadingElement>(null);
  const listenerId = listener?.id;
  useEffect(() => {
    if (listenerId !== undefined) {
      heading.current?.focus({ preventScroll: true });
      heading.current?.scrollIntoView({ block: 'start' });
    }
  }, [listenerId]);
  const { now, expiresAt } = useListenerClock(listener, query.data, active);
  const state = webhookListenerState({
    expiresAt: listener?.expiresAt,
    snapshot: query.data,
    changed: test.changed,
    now,
  });
  const status = WEBHOOK_LISTENER_STATUS[state];
  const output = state === 'captured' ? query.data?.output : undefined;
  return (
    <section
      aria-label="Webhook test event"
      className="flex flex-col gap-3 rounded-lg border border-border p-3"
    >
      <h3
        ref={heading}
        tabIndex={-1}
        className="scroll-mt-4 text-sm font-medium outline-none"
      >
        Receive a real sample
      </h3>
      <p className="text-xs text-muted-foreground">
        A separate test URL captures one request for two minutes without running
        the workflow. Request data may contain secrets. Keeping it as a pin
        shares it with people who can see run data.
      </p>
      <div hidden={listener !== undefined}>
        <ListenerAuthentication
          pending={test.start.isPending}
          onListen={(authentication) => {
            test.start.mutate(authentication);
          }}
        />
      </div>
      {listener === undefined ? null : (
        <>
          <Status role="status" tone={status.tone}>
            {status.label}
          </Status>
          {state === 'waiting' ? (
            <ListenerCredentials
              listener={listener}
              remainingSeconds={Math.max(
                0,
                Math.ceil(((expiresAt ?? 0) - now) / 1000),
              )}
            />
          ) : null}
          {output !== undefined && output !== null ? (
            <CapturedEvent
              key={listener.id}
              scope={scope}
              nodeId={nodeId}
              listenerId={listener.id}
              output={output}
              ensureSaved={ensureSaved}
            />
          ) : null}
          <ProgressButton
            size="sm"
            variant="outline"
            pending={test.stop.isPending}
            pendingLabel="Stopping…"
            onClick={() => {
              test.stop.mutate();
            }}
          >
            {state === 'waiting' ? 'Stop listening' : 'Listen again'}
          </ProgressButton>
        </>
      )}
      {test.error !== undefined ? (
        <Notice tone="destructive">{test.error}</Notice>
      ) : null}
      <QueryView query={query} resource="The listener" loading={null} />
    </section>
  );
}
