import type { WebhookDeliveryResponse } from '@pertexo/contracts';
import { describeCoordinatedEvent } from '@/features/trigger-events/presentation.public';
import type { StatusTone } from '@/components/ui/status';

type DeliveryOutcome = Readonly<{
  tone: StatusTone;
  label: string;
  detail: string;
}>;

const REJECTED_SIGNATURE: DeliveryOutcome = {
  tone: 'failure',
  label: 'Authentication failed',
  detail:
    'Check the authentication mode, credential and allowed browser origin. No run started.',
};
const STALE_TIMESTAMP: DeliveryOutcome = {
  tone: 'failure',
  label: 'Too old',
  detail:
    'Its timestamp was more than 5 minutes off. Check the sender’s clock. No run started.',
};
const NOT_ACCEPTING: DeliveryOutcome = {
  tone: 'attention',
  label: 'Not accepting',
  detail:
    'Authenticated, but the endpoint had stopped taking deliveries. No run started.',
};

/** What happened to one delivery, in words, from its recorded checks. */
export function describeDelivery(
  delivery: Pick<
    WebhookDeliveryResponse,
    'outcome' | 'signatureCheck' | 'replayCheck' | 'coordination'
  >,
): DeliveryOutcome {
  if (delivery.coordination !== undefined) {
    const current = describeCoordinatedEvent(delivery.coordination);
    return delivery.replayCheck === 'duplicate'
      ? {
          ...current,
          tone: 'neutral',
          label: `Duplicate · ${current.label}`,
          detail: `The original event is shown here. No additional run. ${current.detail}`,
        }
      : current;
  }
  switch (delivery.outcome) {
    case 'coordinated':
      return {
        tone: 'neutral',
        label: 'Coordinated',
        detail: 'Coordination history is no longer retained.',
      };
    case 'skipped':
      return {
        tone: 'skipped',
        label: 'Skipped',
        detail: 'Concurrency limit reached. No run started.',
      };
    case 'accepted':
      return { tone: 'success', label: 'Accepted', detail: 'Started a run.' };
    case 'replayed':
      return {
        tone: 'neutral',
        label: 'Duplicate',
        detail: 'Already received, so the earlier run was returned.',
      };
    case 'authentication_failed':
      if (delivery.signatureCheck === 'mismatch') return REJECTED_SIGNATURE;
      if (delivery.replayCheck === 'stale_timestamp') return STALE_TIMESTAMP;
      return NOT_ACCEPTING;
    case 'invalid_request':
      return {
        tone: 'failure',
        label: 'Invalid request',
        detail:
          'Authenticated, but the body wasn’t JSON or the Idempotency-Key was malformed. No run started.',
      };
    case 'conflict':
      return {
        tone: 'attention',
        label: 'Key reused',
        detail:
          'Its Idempotency-Key was already used for a different body. No run started.',
      };
    case 'rate_limited':
      return {
        tone: 'attention',
        label: 'Held back',
        detail:
          'Too many runs were waiting in this workspace. The sender can try again later.',
      };
    case 'paused':
      return {
        tone: 'attention',
        label: 'Paused',
        detail:
          'Authenticated, but the workflow was paused after failing repeatedly. No run started.',
      };
  }
}
