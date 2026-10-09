export {
  PREVIEW_RETENTION_MAX_MS,
  PREVIEW_STATUS,
  PreviewAcceptanceCorruptError,
  PreviewAdmissionDeniedError,
  PreviewIdempotencyConflictError,
  PriorPreviewInputUnavailableError,
  acceptPreviewRun,
} from './acceptance.js';
export type {
  AcceptedPreviewRun,
  AcceptPreviewRunInput,
  PreviewRunRecord,
  PreviewStatus,
} from './acceptance.js';
export { readPreviewRun } from './read.js';
export { resolvePreviewReplay } from './replay.js';
export type {
  PreviewReplayRecord,
  ResolvePreviewReplayInput,
} from './replay.js';

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

export { claimPreviewDelivery } from './claim.js';
export type { PreviewClaimResult } from './claim.js';

export { heartbeatPreviewLease } from './heartbeat.js';
export type { PreviewHeartbeatResult } from './heartbeat.js';

export { markPreviewDispatched } from './dispatch.js';

export { completePreviewAttempt } from './completion.js';
export type { PreviewCompletionResult } from './completion.js';

export {
  isValidStoredExecutionOutput,
  reconcilePreviewDelivery,
} from './reconciliation.js';
export type { PreviewDeliveryReconciliationResult } from './reconciliation.js';
