import { describe, expect, it } from 'vitest';

import {
  assertAttemptTransition,
  assertNodeTransition,
  assertRunTransition,
} from '../src/testing.js';

const policies = [
  {
    name: 'run',
    assert: assertRunTransition,
    expected: {
      queued: ['running', 'canceled', 'timed_out'],
      running: [
        'waiting',
        'succeeded',
        'failed',
        'canceled',
        'timed_out',
        'outcome_unknown',
      ],
      waiting: [
        'running',
        'succeeded',
        'failed',
        'canceled',
        'timed_out',
        'outcome_unknown',
      ],
      succeeded: [],
      failed: [],
      canceled: [],
      timed_out: [],
      outcome_unknown: [],
    },
  },
  {
    name: 'node',
    assert: assertNodeTransition,
    expected: {
      pending: ['ready', 'skipped', 'canceled'],
      ready: ['running', 'skipped', 'canceled'],
      running: [
        'waiting',
        'succeeded',
        'failed',
        'canceled',
        'timed_out',
        'outcome_unknown',
      ],
      waiting: [
        'ready',
        'succeeded',
        'failed',
        'canceled',
        'timed_out',
        'outcome_unknown',
      ],
      succeeded: [],
      failed: [],
      skipped: [],
      canceled: [],
      timed_out: [],
      outcome_unknown: [],
    },
  },
  {
    name: 'attempt',
    assert: assertAttemptTransition,
    expected: {
      pending: ['ready', 'canceled'],
      ready: ['running', 'canceled'],
      running: [
        'succeeded',
        'failed',
        'canceled',
        'timed_out',
        'outcome_unknown',
      ],
      succeeded: [],
      failed: [],
      canceled: [],
      timed_out: [],
      outcome_unknown: [],
    },
  },
] as const;

describe('transition policy mutation canary', () => {
  for (const policy of policies) {
    it(`detects any added or removed ${policy.name} transition`, () => {
      const statuses = Object.keys(
        policy.expected,
      ) as (keyof typeof policy.expected)[];
      for (const from of statuses) {
        for (const to of statuses) {
          const expected = policy.expected[from].includes(to as never);
          let accepted = true;
          try {
            policy.assert(from, to);
          } catch {
            accepted = false;
          }
          expect(accepted, `${from} -> ${to}`).toBe(expected);
        }
      }
    });
  }
});
