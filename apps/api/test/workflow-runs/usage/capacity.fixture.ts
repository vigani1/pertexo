import type { UsageCapacityResponse } from '@pertexo/contracts';

export function usageCapacitySnapshot(): UsageCapacityResponse {
  return {
    asOf: '2026-10-01T12:00:00.123456Z',
    execution: {
      activeRuns: 2,
      reservedActiveSlots: 1,
      activeCapacityConsumed: 3,
      queuedRuns: 4,
      policy: {
        state: 'active',
        version: 1,
        activeRunLimit: 5,
        queuedRunLimit: 100,
      },
    },
    artifacts: {
      chargedBytes: '9007199254740993',
      byteLimit: '9007199254740994',
      chargedCount: 5,
      artifactCountLimit: 1000,
      source: 'stored',
    },
  };
}
