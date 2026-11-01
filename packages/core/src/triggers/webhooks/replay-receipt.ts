import type { EventCoordinationReceipt } from '@pertexo/workflow-model';

import { coordinatedReceipt } from '../coordination/events.repository.js';
import type { WebhookDeliveryOutcome } from './contract.js';
import { WebhookDeliveryReplayMismatchError } from './errors.js';
import type { WebhookReplayRecord } from './replay.repository.js';

export type ExactReplay = ReturnType<typeof resolveExactReplay>;

export function resolveExactReplay(
  replay: WebhookReplayRecord,
  requestFingerprint: string,
):
  | Readonly<{ runId: string; replayed: true }>
  | Readonly<{ skipped: true; reason: 'concurrency_limit' }>
  | EventCoordinationReceipt {
  if (replay.request_fingerprint !== requestFingerprint)
    throw new WebhookDeliveryReplayMismatchError();
  if (replay.skip_reason === 'concurrency_limit')
    return Object.freeze({ skipped: true, reason: 'concurrency_limit' });
  const {
    coordination_event_id,
    workflow_run_id,
    initial_outcome,
    initial_status,
    coordination_reason,
  } = replay;
  const coordinatedWithoutRun =
    coordination_event_id !== null &&
    workflow_run_id === null &&
    initial_outcome !== null &&
    initial_status !== null;
  if (coordinatedWithoutRun)
    return coordinatedReceipt(
      coordination_event_id,
      initial_outcome,
      initial_status,
      initial_status === 'pending' ? null : coordination_reason,
    );
  if (workflow_run_id === null)
    throw new Error('Webhook replay record is incomplete');
  return Object.freeze({ runId: workflow_run_id, replayed: true });
}

export function replayDeliveryOutcome(
  replayed: ExactReplay,
): WebhookDeliveryOutcome {
  if ('skipped' in replayed) return 'skipped';
  return 'coordinated' in replayed ? 'coordinated' : 'replayed';
}

export function replayDeliveryReference(
  replayed: ExactReplay,
): Readonly<{ runId?: string; coordinationEventId?: string }> {
  if ('runId' in replayed) return { runId: replayed.runId };
  return 'coordinated' in replayed
    ? { coordinationEventId: replayed.eventId }
    : {};
}
