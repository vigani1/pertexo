import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallableMaterialDemand } from '@pertexo/workflow-engine';
import {
  boundedNodeJsonRecordSchema,
  type SchemaJson,
} from '@pertexo/node-sdk';
import { JsonataEvaluator } from '@pertexo/workflow-model/expressions';
import { parseWorkflowExecutionValueSnapshot } from '@pertexo/database/execution';
import { createHash } from 'node:crypto';
import {
  createCoordinatorValueWorkLifetime,
  COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
} from '../src/execution/coordinator-value-work-lifetime.js';
import { hydrateCoordinatorExpressionMaterial } from '../src/execution/coordinator-expression-material-hydration.js';

function demand(keys = ['a', 'b']): CallableMaterialDemand {
  return {
    expectedRevision: 4,
    resultSelector: {
      kind: 'expression',
      language: 'jsonata',
      policyVersion: 1,
      expression: 'nodeOutputs',
    },
    requiresRunInput: true,
    sources: keys.map((nodeId, index) => ({
      nodeId,
      invocationKey: nodeId,
      output: {
        kind: 'inline',
        attemptId: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
      },
    })),
  };
}

function nested(levels: number): SchemaJson {
  let value: SchemaJson = 0;
  for (let index = 0; index < levels; index++) value = { child: value };
  return value;
}

const boundaries = [
  {
    name: 'exact context byte bound',
    value: { text: 'x'.repeat(1_048_576 - 49) },
    accepted: true,
  },
  {
    name: 'one byte over context bound',
    value: { text: 'x'.repeat(1_048_576 - 48) },
    accepted: false,
  },
  { name: 'exact context depth', value: nested(62), accepted: true },
  { name: 'one level over context depth', value: nested(63), accepted: false },
  {
    name: 'exact context member count',
    value: Array.from({ length: 9_997 }, () => 0),
    accepted: true,
  },
  {
    name: 'one member over context count',
    value: Array.from({ length: 9_998 }, () => 0),
    accepted: false,
  },
] satisfies readonly { name: string; value: SchemaJson; accepted: boolean }[];

afterEach(() => {
  vi.useRealTimers();
});

describe('sequential decoded coordinator expression material', () => {
  it('leaves cancellation classification to its owned lifetime after joining a decode that settles on abort', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const started = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const context = new AbortController();
    let workSignal: AbortSignal | undefined;
    let checks = 0;
    const lifetime = createCoordinatorValueWorkLifetime({
      policy: COORDINATOR_VALUE_WORK_POLICY_DEFAULTS,
      inspectOwner: () =>
        Promise.resolve(
          ++checks === 1
            ? {
                kind: 'active',
                databaseNow: '2026-10-03T00:00:00.000Z',
                deadlineAt: null,
              }
            : { kind: 'stopped', stop: { kind: 'canceled' } },
        ),
    });
    const owner = {
      workspaceId: '11111111-1111-4111-8111-111111111111',
      runId: '22222222-2222-4222-8222-222222222222',
      workflowVersionId: '33333333-3333-4333-8333-333333333333',
      expectedRevision: 4,
      delivery: {
        outboxEventId: '44444444-4444-4444-8444-444444444444',
        payloadChecksum: 'a'.repeat(64),
      },
    };
    const readOutput = vi.fn(
      async (
        _source: CallableMaterialDemand['sources'][number],
        signal: AbortSignal,
      ) => {
        workSignal = signal;
        started.resolve(undefined);
        await release.promise;
        return { name: 'must-not-escape' };
      },
    );
    const result = lifetime.withValueWork(owner, context.signal, (session) =>
      session.perform((signal) =>
        hydrateCoordinatorExpressionMaterial(
          demand(),
          { readRunInput: () => Promise.resolve(null), readOutput },
          signal,
        ),
      ),
    );
    await started.promise;
    try {
      await vi.advanceTimersByTimeAsync(250);
      expect(workSignal?.aborted).toBe(true);
      release.resolve(undefined);
      await expect(result).resolves.toEqual({
        kind: 'stopped',
        stop: { kind: 'canceled' },
      });
      expect(readOutput).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release.resolve(undefined);
      context.abort();
      await result.catch(() => undefined);
    }
  });
  it('rejects a run input that already exceeds the final context budget before any source read', async () => {
    const readOutput = vi.fn();
    const result = await hydrateCoordinatorExpressionMaterial(
      demand(),
      {
        readRunInput: () => Promise.resolve({ text: 'x'.repeat(1_048_560) }),
        readOutput,
      },
      new AbortController().signal,
    );
    expect(result).toEqual({ kind: 'invalid_context' });
    expect(readOutput).not.toHaveBeenCalled();
  });
  it('joins one in-flight decode on context abort and never starts the next source', async () => {
    const context = new AbortController();
    const started = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const readOutput = vi.fn(
      async (
        _source: CallableMaterialDemand['sources'][number],
        signal: AbortSignal,
      ) => {
        expect(signal).toBe(context.signal);
        started.resolve(undefined);
        await release.promise;
        return { name: 'decoded' };
      },
    );
    let finished = false;
    const result = hydrateCoordinatorExpressionMaterial(
      demand(),
      { readRunInput: () => Promise.resolve(null), readOutput },
      context.signal,
    );
    void result.then(
      () => {
        finished = true;
      },
      () => {
        finished = true;
      },
    );
    await started.promise;
    context.abort();
    await Promise.resolve();
    expect(finished).toBe(false);
    release.resolve(undefined);
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(readOutput).toHaveBeenCalledOnce();
  });
  it('refuses duplicate selected node keys before reading or overwriting decoded context', async () => {
    const readRunInput = vi.fn();
    const readOutput = vi.fn();
    await expect(
      hydrateCoordinatorExpressionMaterial(
        demand(['a', 'a']),
        { readRunInput, readOutput },
        new AbortController().signal,
      ),
    ).rejects.toThrow('inventory is invalid');
    expect(readRunInput).not.toHaveBeenCalled();
    expect(readOutput).not.toHaveBeenCalled();
  });
  it.each(boundaries)(
    'agrees with the existing final record validator and actual evaluator at $name',
    async ({ value, accepted }) => {
      const evaluator = new JsonataEvaluator({ maxActive: 1 });
      try {
        const record = { a: value };
        const final =
          boundedNodeJsonRecordSchema.safeParse(record).success &&
          (
            await evaluator.evaluate({
              expression: '{"accepted":true}',
              policyVersion: 1,
              context: { runInput: null, nodeOutputs: record },
            })
          ).kind === 'value';
        expect(final).toBe(accepted);
        const result = await hydrateCoordinatorExpressionMaterial(
          demand(['a']),
          {
            readRunInput: () => Promise.resolve(null),
            readOutput: () => Promise.resolve(value),
          },
          new AbortController().signal,
        );
        expect(result.kind === 'ready').toBe(accepted);
      } finally {
        await evaluator.shutdown();
      }
    },
  );

  it.each([
    ['a', 'b'],
    ['b', 'a'],
  ])(
    'agrees with final validation for source order %j and JSON spelling edge cases',
    async (...keys) => {
      const evaluator = new JsonataEvaluator({ maxActive: 1 });
      const value = {
        '10': 'ten',
        '2': 'two',
        'nul\u0000': '\u0000',
        quote: '"\\',
        supplementary: '😀',
        rounded: 0.12345678901234568,
        zero: -0,
      };
      const record = { a: value, b: structuredClone(value) };
      try {
        expect(boundedNodeJsonRecordSchema.safeParse(record).success).toBe(
          true,
        );
        expect(
          await evaluator.evaluate({
            expression: '{"accepted":true}',
            policyVersion: 1,
            context: { runInput: null, nodeOutputs: record },
          }),
        ).toMatchObject({ kind: 'value' });
        const result = await hydrateCoordinatorExpressionMaterial(
          demand(keys),
          {
            readRunInput: () => Promise.resolve(null),
            readOutput: () => Promise.resolve(value),
          },
          new AbortController().signal,
        );
        expect(result.kind).toBe('ready');
      } finally {
        await evaluator.shutdown();
      }
    },
  );

  it('validates decoded context rather than imposing a new limit on whitespace-rich original inline bytes', async () => {
    const original = ' '.repeat(240_000) + '{"name":"accepted"}';
    const snapshot = parseWorkflowExecutionValueSnapshot({
      reference: {
        schemaVersion: 1,
        kind: 'inline',
        value: { name: 'accepted' },
      },
      serializedValue: original,
      byteLength: Buffer.byteLength(original),
      sha256: createHash('sha256').update(original).digest('hex'),
    });
    if (snapshot.reference.kind !== 'inline')
      throw new Error('Inline fixture is invalid');
    const value = snapshot.reference.value;
    const result = await hydrateCoordinatorExpressionMaterial(
      demand(['a', 'b', 'c', 'd', 'e', 'f']),
      {
        readRunInput: () => Promise.resolve(null),
        readOutput: () => Promise.resolve(value),
      },
      new AbortController().signal,
    );
    expect(Buffer.byteLength(original) * 6).toBeGreaterThan(1_048_576);
    expect(result.kind).toBe('ready');
    expect(snapshot.serializedValue).toBe(original);
  });

  it('preserves missing/corrupt source authority errors rather than treating them as invalid context', async () => {
    const failure = new TypeError('Accepted source proof is corrupt');
    const readOutput = vi.fn().mockRejectedValue(failure);
    await expect(
      hydrateCoordinatorExpressionMaterial(
        demand(),
        { readRunInput: () => Promise.resolve(null), readOutput },
        new AbortController().signal,
      ),
    ).rejects.toBe(failure);
    expect(readOutput).toHaveBeenCalledOnce();
  });
  it('stops before reading another source once the growing decoded context exceeds the existing bound', async () => {
    const readOutput = vi.fn().mockResolvedValue({ text: 'x'.repeat(600_000) });
    await expect(
      hydrateCoordinatorExpressionMaterial(
        demand(['a', 'b', 'must-not-read']),
        { readRunInput: () => Promise.resolve(null), readOutput },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: 'invalid_context' });
    expect(readOutput).toHaveBeenCalledTimes(2);
  });
  it('preserves inspected source order and immutable routing without giving the reader checkpoint aliases', async () => {
    const requested = demand();
    const events: string[] = [];
    const readOutput = vi.fn(
      (source: CallableMaterialDemand['sources'][number]) => {
        events.push(source.nodeId);
        Reflect.set(source, 'invocationKey', 'mutated');
        return Promise.resolve({ number: -0 });
      },
    );
    const result = await hydrateCoordinatorExpressionMaterial(
      requested,
      { readRunInput: () => Promise.resolve({ name: 'input' }), readOutput },
      new AbortController().signal,
    );
    expect(events).toEqual(['a', 'b']);
    expect(result).toEqual({
      kind: 'ready',
      material: {
        runInput: { name: 'input' },
        outputs: requested.sources.map((source) => ({
          invocationKey: source.invocationKey,
          output: source.output,
          value: { number: 0 },
        })),
      },
    });
    expect(requested.sources.map(({ invocationKey }) => invocationKey)).toEqual(
      ['a', 'b'],
    );
  });
});
