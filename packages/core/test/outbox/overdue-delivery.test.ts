import { describe, expect, it } from 'vitest';
import { overdueDeliveryAction } from '../../src/outbox/overdue-delivery.js';

describe('overdueDeliveryAction', () => {
  it.each([
    ['advance-workflow-run', 'running', undefined, 'replace'],
    ['advance-workflow-run', 'waiting', undefined, 'replace'],
    ['advance-workflow-run', 'queued', undefined, 'replace'],
    ['advance-workflow-run', 'succeeded', undefined, 'drop'],
    ['advance-workflow-run', undefined, undefined, 'drop'],
    ['execute-node-attempt', 'running', 'ready', 'replace'],
    ['execute-node-attempt', 'waiting', 'ready', 'replace'],
    ['execute-node-attempt', 'running', 'running', 'drop'],
    ['execute-node-attempt', 'running', 'succeeded', 'drop'],
    ['execute-node-attempt', 'canceled', 'ready', 'drop'],
  ] as const)(
    '%s on a %s run with a %s attempt: %s',
    (jobName, runStatus, attemptStatus, action) => {
      expect(overdueDeliveryAction({ jobName, runStatus, attemptStatus })).toBe(
        action,
      );
    },
  );
});
