export {
  PREVIEW_RETENTION_MAX_MS,
  PREVIEW_STATUS,
  PreviewAcceptanceCorruptError,
  PreviewAdmissionDeniedError,
  PreviewIdempotencyConflictError,
  PriorPreviewInputUnavailableError,
  acceptPreviewRun,
  readPreviewRun,
} from './preview-execution-acceptance.js';
export type {
  AcceptedPreviewRun,
  AcceptPreviewRunInput,
  PreviewRunRecord,
  PreviewStatus,
} from './preview-execution-acceptance.js';

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
} from './preview-execution-contract.js';
export type {
  PreviewAttemptLease,
  PreviewDelivery,
  PreviewTerminalOutcome,
} from './preview-execution-contract.js';

export { claimPreviewDelivery } from './preview-execution-claim.js';
export type { PreviewClaimResult } from './preview-execution-claim.js';

export { heartbeatPreviewLease } from './preview-execution-heartbeat.js';
export type { PreviewHeartbeatResult } from './preview-execution-heartbeat.js';

export { markPreviewDispatched } from './preview-execution-dispatch.js';

export { completePreviewAttempt } from './preview-execution-completion.js';
export type { PreviewCompletionResult } from './preview-execution-completion.js';

export {
  isValidStoredExecutionOutput,
  reconcileExpiredPreviewAttempt,
  reconcilePreviewDelivery,
} from './preview-execution-reconciliation.js';
export type {
  PreviewDeliveryReconciliationResult,
  PreviewReconciliationOutcome,
} from './preview-execution-reconciliation.js';
