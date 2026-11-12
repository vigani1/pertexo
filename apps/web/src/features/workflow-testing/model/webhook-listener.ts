import type { WebhookTestEventSnapshot } from '@pertexo/contracts';
export function webhookListenerState(
  input: Readonly<{
    expiresAt: string | undefined;
    snapshot: WebhookTestEventSnapshot | undefined;
    changed: boolean;
    now: number;
  }>,
) {
  if (input.expiresAt === undefined) return 'idle';
  if (input.changed || input.snapshot?.state === 'changed') return 'changed';
  const expiresAt = Date.parse(input.snapshot?.expiresAt ?? input.expiresAt);
  if (input.snapshot?.state === 'expired' || expiresAt <= input.now)
    return 'expired';
  return input.snapshot?.state === 'captured' ? 'captured' : 'waiting';
}
export const WEBHOOK_LISTENER_STATUS = {
  idle: { tone: 'neutral', label: 'Ready to listen' },
  waiting: { tone: 'live', label: 'Listening for one request…' },
  captured: { tone: 'success', label: 'Test event received' },
  changed: { tone: 'attention', label: 'Step changed — listen again' },
  expired: { tone: 'attention', label: 'Listener expired or replaced' },
} as const;
