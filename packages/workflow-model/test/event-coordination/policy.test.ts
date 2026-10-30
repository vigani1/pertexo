import { afterAll, expect, it } from 'vitest';
import {
  eventCoordinationPolicySchema,
  isEventCoordinationTrigger,
} from '../../src/triggers/event-coordination/contract.js';
import { decideEventCoordination } from '../../src/triggers/event-coordination/decision.js';
import {
  resolveEventCoordinationKey,
  inspectEventCoordinationExpression,
} from '../../src/triggers/event-coordination/key.js';
import { JsonataEvaluator } from '../../src/values/expressions/evaluator.js';
const key = { kind: 'run_input', path: '$.id' } as const;
const evaluator = new JsonataEvaluator();
afterAll(() => evaluator.shutdown());
it('defaults each policy and rejects unsupported key sources and out-of-bound windows', () => {
  expect(
    eventCoordinationPolicySchema.parse({ mode: 'deduplicate', key }),
  ).toMatchObject({ windowSeconds: 86400 });
  expect(
    eventCoordinationPolicySchema.parse({ mode: 'debounce', key }),
  ).toMatchObject({ quietSeconds: 5 });
  expect(
    eventCoordinationPolicySchema.parse({ mode: 'throttle', key }),
  ).toMatchObject({ limit: 1, windowSeconds: 60, onExcess: 'skip' });
  for (const input of [
    { mode: 'deduplicate', key, windowSeconds: 604801 },
    { mode: 'debounce', key, quietSeconds: 3601 },
    { mode: 'throttle', key, limit: 1001 },
    { mode: 'throttle', key, windowSeconds: 0 },
    { mode: 'debounce', key: { kind: 'workspace_variable', name: 'KEY' } },
    { mode: 'debounce', key: { kind: 'run_input', path: '$..id' } },
  ])
    expect(eventCoordinationPolicySchema.safeParse(input).success).toBe(false);
  expect(isEventCoordinationTrigger({ key: 'core.form', version: 1 })).toBe(
    true,
  );
  expect(isEventCoordinationTrigger({ key: 'core.schedule', version: 1 })).toBe(
    false,
  );
});
it.each([
  ['42', '"42"'],
  [42, '42'],
  [false, 'false'],
  ['é'.repeat(256), JSON.stringify('é'.repeat(256))],
] as const)('preserves typed key identity: %s', async (id, canonical) => {
  expect(
    await resolveEventCoordinationKey(
      { mode: 'debounce', key, quietSeconds: 1 },
      { id },
      evaluator,
    ),
  ).toEqual({ kind: 'key', canonical });
});
it.each([null, [], {}, '', 'é'.repeat(257)])(
  'refuses unusable key without echoing input',
  async (id) => {
    expect(
      await resolveEventCoordinationKey(
        { mode: 'debounce', key, quietSeconds: 1 },
        { id },
        evaluator,
      ),
    ).toEqual({ kind: 'invalid' });
  },
);
it('evaluates keys using the existing restricted evaluator and rejects variable references at publish', async () => {
  expect(inspectEventCoordinationExpression('runInput.id')).toBeUndefined();
  expect(inspectEventCoordinationExpression('$vars.SECRET')).toBeDefined();
  expect(inspectEventCoordinationExpression('(')).toBeDefined();
  expect(
    await resolveEventCoordinationKey(
      {
        mode: 'debounce',
        key: {
          kind: 'expression',
          language: 'jsonata',
          expression: '$lowercase(runInput.id)',
        },
        quietSeconds: 1,
      },
      { id: 'ORDER-42' },
      evaluator,
    ),
  ).toEqual({ kind: 'key', canonical: '"order-42"' });
});
it('uses fixed windows, exact boundary expiry and FIFO admission without charging a token prematurely', () => {
  const policy = {
    mode: 'throttle',
    key,
    windowSeconds: 60,
    limit: 2,
    onExcess: 'delay',
  } as const;
  expect(
    decideEventCoordination({
      policy,
      now: 60000,
      window: { startedAt: 0, used: 2 },
      hasPending: false,
    }),
  ).toEqual({ action: 'start', window: { startedAt: 60000, used: 0 } });
  expect(
    decideEventCoordination({
      policy,
      now: 100,
      window: { startedAt: 0, used: 1 },
      hasPending: true,
    }),
  ).toMatchObject({ action: 'throttled', dueAt: 100, window: { used: 1 } });
  expect(
    decideEventCoordination({
      policy,
      now: 100,
      window: { startedAt: 0, used: 2 },
      hasPending: false,
    }),
  ).toMatchObject({ action: 'throttled', dueAt: 60000 });
  expect(
    decideEventCoordination({
      policy: { mode: 'deduplicate', key, windowSeconds: 60 },
      now: 100,
      window: { startedAt: 0, used: 1 },
      hasPending: false,
    }),
  ).toEqual({ action: 'deduplicated', window: { startedAt: 0, used: 1 } });
  expect(
    decideEventCoordination({
      policy: { mode: 'debounce', key, quietSeconds: 10 },
      now: 100,
      hasPending: true,
    }),
  ).toMatchObject({ action: 'debounced', dueAt: 10100 });
});
it('refuses a key that can never work and asks the sender to retry when the host is busy', async () => {
  const policy = eventCoordinationPolicySchema.parse({
    mode: 'deduplicate',
    key: { kind: 'expression', language: 'jsonata', expression: '1' },
  });
  const failing = (
    error: Readonly<{
      code:
        'evaluation_failed' | 'limit_exceeded' | 'timed_out' | 'unavailable';
      limit?: 'memory' | 'pool_capacity';
    }>,
  ) => ({
    evaluate: () =>
      Promise.resolve({ kind: 'error' as const, message: 'no', ...error }),
  });
  for (const error of [
    { code: 'evaluation_failed' },
    { code: 'limit_exceeded', limit: 'memory' },
  ] as const)
    expect(
      await resolveEventCoordinationKey(policy, {}, failing(error)),
    ).toEqual({ kind: 'invalid' });
  for (const error of [
    { code: 'timed_out' },
    { code: 'unavailable' },
    { code: 'limit_exceeded', limit: 'pool_capacity' },
  ] as const)
    expect(
      await resolveEventCoordinationKey(policy, {}, failing(error)),
    ).toEqual({ kind: 'unavailable' });
});
