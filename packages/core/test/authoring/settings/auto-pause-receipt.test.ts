import { expect, it } from 'vitest';
import { workflowSettings } from '../../../src/authoring/settings/auto-pause/auto-pause-receipts.schemas.js';

it('rejects a replay receipt for a pause with missing or conflicting evidence', () => {
  const unpaused = {
    enabled: true,
    thresholdOverride: null,
    workspaceThreshold: 10,
    effectiveThreshold: 10,
    settingsRevision: 1,
    pauseRevision: '1',
    pauseState: 'none',
    pauseReason: null,
    pausedAt: null,
    pausedFailures: null,
    pausedLastRunId: null,
  };
  const manual = {
    ...unpaused,
    pauseState: 'paused',
    pauseReason: 'manual',
    pausedAt: '2026-11-28T08:00:00.000000Z',
  };
  for (const invalid of [
    { ...unpaused, pauseState: 'paused' },
    manual,
    { ...manual, pauseReason: 'consecutive_failures', pausedFailures: 4 },
    {
      ...manual,
      pausedBy: {
        id: '11111111-1111-4111-8111-111111111111',
        displayName: null,
      },
      pausedFailures: 4,
    },
  ]) {
    expect(workflowSettings.safeParse(invalid).success).toBe(false);
  }
  const valid = {
    ...manual,
    pausedBy: { id: '11111111-1111-4111-8111-111111111111', displayName: null },
  };
  expect(workflowSettings.parse(valid)).toEqual(valid);
});
