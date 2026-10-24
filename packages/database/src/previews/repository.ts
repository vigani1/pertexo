export {
  PREVIEW_RETENTION_MAX_MS,
  PREVIEW_STATUS,
  PreviewAcceptanceCorruptError,
  PreviewAdmissionDeniedError,
  PreviewIdempotencyConflictError,
  PriorPreviewInputUnavailableError,
  acceptPreviewRun,
} from './runs/acceptance.repository.js';
export type {
  AcceptedPreviewRun,
  AcceptPreviewRunInput,
  PreviewRunRecord,
  PreviewStatus,
} from './runs/acceptance.repository.js';
export { readPreviewRun } from './runs/records.queries.js';
export { resolvePreviewReplay } from './runs/replay.repository.js';
export type {
  PreviewReplayRecord,
  ResolvePreviewReplayInput,
} from './runs/replay.repository.js';

// ---------------------------------------------------------------------------
// Worker-side execution seam.
//
// The API role owns immutable preview identity (acceptance above). The worker
// owns only lifecycle columns granted by migration 0022 and every mutation is
// fenced by the monotonic attempt token under forced RLS. Deliveries bind to
// their durable outbox aggregate exactly like production node attempts, so a
// forged or drifted BullMQ payload can never drive a preview.
// ---------------------------------------------------------------------------

export {
  PreviewAttemptStateError,
  PreviewDeliveryMismatchError,
} from './contract.js';
export type {
  PreviewAttemptLease,
  PreviewDelivery,
  PreviewTerminalOutcome,
} from './contract.js';

export { claimPreviewDelivery } from './attempts/claim.repository.js';
export type { PreviewClaimResult } from './attempts/claim.repository.js';

export { heartbeatPreviewLease } from './attempts/heartbeat.repository.js';
export type { PreviewHeartbeatResult } from './attempts/heartbeat.repository.js';

export { markPreviewDispatched } from './attempts/dispatch.repository.js';

export { completePreviewAttempt } from './attempts/completion.repository.js';
export type { PreviewCompletionResult } from './attempts/completion.repository.js';

export {
  isValidStoredExecutionOutput,
  reconcilePreviewDelivery,
} from './reconciliation/deliveries.repository.js';
export type { PreviewDeliveryReconciliationResult } from './reconciliation/deliveries.repository.js';
