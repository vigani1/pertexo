import { it, expect } from 'vitest';

import { asAdmin, nodeAttemptStore, randomUUID } from '../../fixtures.js';
import { claimDispatchAttempt } from '../fixture.js';

// worker-01: the abort decision is one tagged value, so a reason can never be
// missing from an abort. Cancellation wins over a passed deadline.
export function registerReportsAbortControlOnce(): void {
  it.fails.each([
    { control: undefined, expected: { kind: 'none' } },
    { control: 'canceled', expected: { kind: 'abort', reason: 'canceled' } },
    { control: 'timed_out', expected: { kind: 'abort', reason: 'timed_out' } },
    {
      control: 'canceled_after_deadline',
      expected: { kind: 'abort', reason: 'canceled' },
    },
  ] as const)(
    'reports $expected.kind control for $control on load and heartbeat',
    async ({ control, expected }) => {
      const lease = await claimDispatchAttempt(`abort-${randomUUID()}`, {
        ...(control === undefined
          ? {}
          : {
              control:
                control === 'canceled_after_deadline' ? 'canceled' : control,
            }),
      });
      if (control === 'canceled_after_deadline')
        await asAdmin((client) =>
          client.query(
            'update app.workflow_runs set deadline_at=clock_timestamp() where id=$1',
            [lease.runId],
          ),
        );
      const signal = new AbortController().signal;

      const loaded = await nodeAttemptStore.loadInputs({
        lease,
        upstreamNodeOutputs: [],
        signal,
      });
      const heartbeat = await nodeAttemptStore.heartbeat({
        lease,
        leaseDurationSeconds: 30,
        signal,
      });

      for (const result of [loaded, heartbeat]) {
        expect(result).toMatchObject({ control: expected });
        expect(result).not.toHaveProperty('abortRequested');
        expect(result).not.toHaveProperty('abortReason');
      }
    },
  );
}
