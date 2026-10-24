import type { AcceptedDelivery } from '../../../support/previews/consumer.js';

export function previewCrashCases() {
  return [
    {
      barrierAttemptStatus: 'running',
      barrierInboxCompletedCount: '0',
      barrierRunStatus: 'running',
      expectedAuditCount: '0',
      expectedBarrier: 'preview.before_dispatch_marker_commit',
      expectedDispatch: false,
      expectedFinalFence: '2',
      expectedProviderCount: 0,
      expectedReconciledStatus: 'queued',
      expectedUsageCount: '0',
      mode: 'before-dispatch-commit',
      terminalCommitted: false,
    },
    {
      barrierAttemptStatus: 'running',
      barrierInboxCompletedCount: '0',
      barrierRunStatus: 'running',
      expectedAuditCount: '1',
      expectedBarrier: 'preview.dispatch_marker_committed_before_provider',
      expectedDispatch: true,
      expectedFinalFence: '2',
      expectedProviderCount: 0,
      expectedReconciledStatus: 'outcome_unknown',
      expectedUsageCount: '1',
      mode: 'after-dispatch-before-provider',
      terminalCommitted: false,
    },
    {
      barrierAttemptStatus: 'running',
      barrierInboxCompletedCount: '0',
      barrierRunStatus: 'running',
      expectedAuditCount: '1',
      expectedBarrier: 'preview.provider_completed_before_outcome_commit',
      expectedDispatch: true,
      expectedFinalFence: '2',
      expectedProviderCount: 1,
      expectedReconciledStatus: 'outcome_unknown',
      expectedUsageCount: '1',
      mode: 'after-provider-before-outcome',
      terminalCommitted: false,
    },
    {
      barrierAttemptStatus: 'succeeded',
      barrierInboxCompletedCount: '1',
      barrierRunStatus: 'succeeded',
      expectedAuditCount: '1',
      expectedBarrier: 'preview.outcome_committed_before_queue_ack',
      expectedDispatch: true,
      expectedFinalFence: '1',
      expectedProviderCount: 1,
      expectedReconciledStatus: 'succeeded',
      expectedUsageCount: '1',
      mode: 'after-outcome-before-ack',
      terminalCommitted: true,
    },
  ] as const;
}

export interface PreviewCrashFixture {
  delivery: AcceptedDelivery;
  effectKey: string;
  jobId: string;
  selected: ReturnType<typeof previewCrashCases>[number];
}
