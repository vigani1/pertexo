import { expect, it } from 'vitest';
import * as engine from '@pertexo/workflow-engine/server';

it('keeps administrative command and lease-recovery policy out of the engine entry', () => {
  const administrative = new Set([
    'attemptReconciliationOutcome',
    'automaticReconciliationAction',
    'overdueDeliveryAction',
    'evidenceOutcome',
    'resumeOutcome',
    'cancellationOutcome',
    'triggerReconciliationOutcome',
    'runReplayOutcome',
    'redispatchOutcome',
  ]);
  expect(
    Object.keys(engine).filter((name) => administrative.has(name)),
  ).toEqual([]);
});
