import type { WebhookDeliveryResponse } from '@pertexo/contracts/schemas/webhooks';
import type { StatusTone } from '@/components/ui/status';

type DeliveryOutcome = Readonly<{
  tone: StatusTone;
  label: string;
  detail: string;
}>;

const REJECTED_SIGNATURE: DeliveryOutcome = {
  tone: 'failure',
  label: 'Signature didn’t match',
  detail:
    'Check that the sender signs with the current signing secret. No run started.',
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
    'Signed correctly, but the endpoint had stopped taking deliveries. No run started.',
};

/** What happened to one delivery, in words, from its recorded checks. */
export function describeDelivery(
  delivery: Pick<
    WebhookDeliveryResponse,
    'outcome' | 'signatureCheck' | 'replayCheck'
  >,
): DeliveryOutcome {
  switch (delivery.outcome) {
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
          'Signed correctly, but the body wasn’t JSON or the Idempotency-Key was malformed. No run started.',
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
  }
}
