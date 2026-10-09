export {
  PREVIEW_RETENTION_MAX_MS,
  PREVIEW_STATUS,
  PreviewAcceptanceCorruptError,
  PreviewAdmissionDeniedError,
  PreviewIdempotencyConflictError,
  PriorPreviewInputUnavailableError,
  acceptPreviewRun,
} from './runs/acceptance.js';
export type {
  AcceptedPreviewRun,
  AcceptPreviewRunInput,
  PreviewRunRecord,
  PreviewStatus,
} from './runs/acceptance.js';
export { readPreviewRun } from './runs/read.js';
export { resolvePreviewReplay } from './runs/replay.js';
export type {
  PreviewReplayRecord,
  ResolvePreviewReplayInput,
} from './runs/replay.js';

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

export { claimPreviewDelivery } from './attempts/claim.js';
export type { PreviewClaimResult } from './attempts/claim.js';

export { heartbeatPreviewLease } from './attempts/heartbeat.js';
export type { PreviewHeartbeatResult } from './attempts/heartbeat.js';

export { markPreviewDispatched } from './attempts/dispatch.js';

export { completePreviewAttempt } from './attempts/completion.js';
export type { PreviewCompletionResult } from './attempts/completion.js';

export {
  isValidStoredExecutionOutput,
  reconcilePreviewDelivery,
} from './reconciliation/deliveries.js';
export type { PreviewDeliveryReconciliationResult } from './reconciliation/deliveries.js';
