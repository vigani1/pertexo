import type {
  EventCoordinationReason,
  EventCoordinationStatus,
} from '@pertexo/workflow-model';
import type { StatusTone } from '@/components/ui/status';
const reasons: Record<EventCoordinationReason, string> = {
  duplicate_key: 'An event with this key was already accepted in this window.',
  newer_event: 'A newer event replaced this input. Only the latest will run.',
  throttle_limit: 'This key reached its run limit for the window.',
  invalid_key:
    'The key must resolve to nonempty text, a number or true/false within 512 bytes.',
  coordination_full:
    'The workspace has too many pending events or active keys. Try again shortly.',
  coordination_timeout:
    'The event expired before it could start. Send a new event if still needed.',
  queue_full: 'The workspace run queue is full.',
  concurrency_limit:
    'The workflow was already running at its concurrency limit.',
  workflow_unavailable: 'The workflow or workspace stopped accepting events.',
  publication_changed:
    'The published version changed before this event started.',
  endpoint_disabled: 'The webhook endpoint stopped accepting events.',
};
export function describeCoordinatedEvent(
  event: Readonly<{
    status: EventCoordinationStatus;
    reason: EventCoordinationReason | null;
  }>,
) {
  const look: Record<
    EventCoordinationStatus,
    Readonly<{ tone: StatusTone; label: string; detail: string }>
  > = {
    pending: {
      tone: 'waiting',
      label: 'Pending',
      detail: 'Accepted for later. No run has started yet.',
    },
    started: { tone: 'success', label: 'Started', detail: 'Started one run.' },
    coalesced: {
      tone: 'skipped',
      label: 'Replaced by a newer event',
      detail: '',
    },
    skipped: {
      tone: 'skipped',
      label: 'Skipped',
      detail: 'No new run started.',
    },
    refused: {
      tone: 'attention',
      label: 'Not started',
      detail: 'This event was refused.',
    },
  };
  const result = look[event.status];
  return {
    ...result,
    detail: event.reason === null ? result.detail : reasons[event.reason],
  };
}
