import type { PREVIEW_STATUS } from '../state.js';
import type { reconcilePreviewDelivery } from './reconcile.js';

export type PreviewDeliveryReconciliationResult =
  | Readonly<{ kind: 'duplicate' }>
  | Readonly<{
      kind: 'rescheduled';
      reconciliationOutboxEventId: string;
    }>
  | Readonly<{
      executionOutboxEventId: string;
      kind: 'redelivered';
    }>
  | Readonly<{
      kind: 'completed';
      mayContactProvider: boolean;
      mayCauseExternalSideEffect: boolean;
      operationKey?: string;
      possiblyDispatched: boolean;
      providerKey?: string;
      sideEffectClass: 'safe' | 'idempotent_with_key' | 'unsafe';
      status:
        typeof PREVIEW_STATUS.outcomeUnknown | typeof PREVIEW_STATUS.timedOut;
      usesConnection: boolean;
    }>;

export type PreviewReconciliationScope = Readonly<{
  attemptFenceToken: number;
  previewAttemptId: string;
  previewRunId: string;
  workspaceId: string;
}>;

export interface PreviewReconciliationStore {
  reconcile(
    input: Parameters<typeof reconcilePreviewDelivery>[1],
  ): ReturnType<typeof reconcilePreviewDelivery>;
}
