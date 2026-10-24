export function failureContext() {
  return {
    runId: '22222222-2222-4222-8222-222222222222',
    workflowId: '33333333-3333-4333-8333-333333333333',
    workflowVersionId: '44444444-4444-4444-8444-444444444444',
    terminalEventSequence: 7,
    terminalStatus: 'failed' as const,
    triggerType: 'manual' as const,
    startedAt: '2026-08-24T10:00:00.000Z',
    completedAt: '2026-08-24T10:01:00.000Z',
    primaryFailure: {
      nodeId: 'send',
      invocationKey: 'send',
      nodeStatus: 'failed' as const,
      attemptNumber: 1,
      safeErrorCode: 'provider.failure',
    },
    totalFailureCount: 1,
  };
}
