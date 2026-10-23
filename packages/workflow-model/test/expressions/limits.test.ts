import { Worker } from 'node:worker_threads';

import { describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '../../src/values/json/canonical.js';
import { JsonataEvaluator } from '../../src/values/expressions/evaluator.js';
import { EXPRESSION_POLICY } from '../../src/values/expressions/policy.js';
import { evaluators, ControlledWorker } from '../support/expression-owner.js';
describe('restricted JSONata policy v1', () => {
  it('enforces input/output limits, cancellation, pool admission, and restart', async () => {
    const evaluator = new JsonataEvaluator({ maxActive: 1, maxQueued: 0 });
    evaluators.push(evaluator);
    const context = {
      runInput: { text: 'x'.repeat(EXPRESSION_POLICY.inputBytes) },
      nodeOutputs: {},
    };
    expect(await evaluator.evaluate({ expression: '1', context })).toEqual(
      expect.objectContaining({ kind: 'error', limit: 'input_bytes' }),
    );
    const controller = new AbortController();
    controller.abort();
    expect(
      await evaluator.evaluate({
        expression: '1',
        context: { runInput: null, nodeOutputs: {} },
        signal: controller.signal,
      }),
    ).toEqual(expect.objectContaining({ kind: 'error', code: 'canceled' }));
    expect(
      await evaluator.evaluate({
        expression: '"x"',
        context: { runInput: null, nodeOutputs: {} },
      }),
    ).toEqual({ kind: 'value', value: 'x', canonicalBytes: 3 });
  });
  it('accepts exact input and output byte/member limits and rejects one over', async () => {
    const evaluator = new JsonataEvaluator();
    evaluators.push(evaluator);
    const empty = { runInput: '', nodeOutputs: {} };
    const overhead = new TextEncoder().encode(JSON.stringify(empty)).byteLength;
    const exactContext = {
      runInput: 'x'.repeat(EXPRESSION_POLICY.inputBytes - overhead),
      nodeOutputs: {},
    };
    expect(
      await evaluator.evaluate({
        expression: '1',
        context: exactContext,
      }),
    ).toEqual({ kind: 'value', value: 1, canonicalBytes: 1 });
    expect(
      await evaluator.evaluate({
        expression: '1',
        context: { ...exactContext, runInput: `${exactContext.runInput}x` },
      }),
    ).toEqual(expect.objectContaining({ kind: 'error', limit: 'input_bytes' }));
    expect(
      await evaluator.evaluate({
        expression: '[1..10000]',
        context: empty,
      }),
    ).toEqual(expect.objectContaining({ kind: 'value' }));
    expect(
      await evaluator.evaluate({
        expression: '[1..10001]',
        context: empty,
      }),
    ).toEqual(
      expect.objectContaining({ kind: 'error', limit: 'output_members' }),
    );
    expect(
      await evaluator.evaluate({
        expression: '$pad("",1048574,"x")',
        context: empty,
      }),
    ).toEqual(
      expect.objectContaining({ kind: 'value', canonicalBytes: 1048576 }),
    );
    expect(
      await evaluator.evaluate({
        expression: '$pad("",1048575,"x")',
        context: empty,
      }),
    ).toEqual(
      expect.objectContaining({ kind: 'error', limit: 'output_bytes' }),
    );
  });
  it('accepts exact input depth/member limits and rejects one over', async () => {
    const evaluator = new JsonataEvaluator();
    evaluators.push(evaluator);
    const nested = (depth: number): JsonValue => {
      let value: JsonValue = null;
      for (let index = 0; index < depth; index += 1) value = [value];
      return value;
    };
    const exactDepth = { runInput: nested(63), nodeOutputs: {} };
    expect(
      await evaluator.evaluate({
        expression: '1',
        context: exactDepth,
      }),
    ).toEqual({ kind: 'value', value: 1, canonicalBytes: 1 });
    expect(
      await evaluator.evaluate({
        expression: '1',
        context: { runInput: nested(64), nodeOutputs: {} },
      }),
    ).toEqual(expect.objectContaining({ kind: 'error', limit: 'input_depth' }));
    expect(
      await evaluator.evaluate({
        expression: '1',
        context: {
          runInput: Array.from({ length: 9_998 }, () => null),
          nodeOutputs: {},
        },
      }),
    ).toEqual({ kind: 'value', value: 1, canonicalBytes: 1 });
    expect(
      await evaluator.evaluate({
        expression: '1',
        context: {
          runInput: Array.from({ length: 9_999 }, () => null),
          nodeOutputs: {},
        },
      }),
    ).toEqual(
      expect.objectContaining({ kind: 'error', limit: 'input_members' }),
    );
  });
  it('accepts exact output depth and rejects one over', async () => {
    const evaluator = new JsonataEvaluator();
    evaluators.push(evaluator);
    let runInput: JsonValue = null;
    for (let index = 0; index < 63; index += 1) runInput = [runInput];
    const context = { runInput, nodeOutputs: {} };
    expect(
      await evaluator.evaluate({
        expression: '{"x": runInput}',
        context,
      }),
    ).toEqual(expect.objectContaining({ kind: 'value' }));
    expect(
      await evaluator.evaluate({
        expression: '{"x": {"y": runInput}}',
        context,
      }),
    ).toEqual(
      expect.objectContaining({ kind: 'error', limit: 'output_depth' }),
    );
  });
  it('hard-terminates expensive work, rejects overflow, and serves the next evaluation', async () => {
    const exits: number[] = [];
    const evaluator = new JsonataEvaluator({
      maxActive: 1,
      maxQueued: 0,
      workerFactory: (runtimeUrl, options) => {
        const worker = new Worker(runtimeUrl, options);
        worker.once('exit', (code) => exits.push(code));
        return worker;
      },
    });
    evaluators.push(evaluator);
    const context = { runInput: null, nodeOutputs: {} };
    const expensive = evaluator.evaluate({
      expression: '$distinct([1..50000])',
      context,
    });
    expect(await evaluator.evaluate({ expression: '1', context })).toEqual(
      expect.objectContaining({ kind: 'error', limit: 'pool_capacity' }),
    );
    expect(await expensive).toEqual(
      expect.objectContaining({ kind: 'error', code: 'timed_out' }),
    );
    expect(exits).toEqual([1]);
    expect(await evaluator.evaluate({ expression: '2', context })).toEqual({
      kind: 'value',
      value: 2,
      canonicalBytes: 1,
    });
    expect(exits).toHaveLength(2);
    expect(evaluator.diagnostics()).toMatchObject({
      workerCreations: 2,
      peakWorkers: 1,
    });
  });
  it('starts the evaluation deadline after startup and retains capacity until timeout termination finishes', async () => {
    vi.useFakeTimers();
    const worker = new ControlledWorker();
    const evaluator = new JsonataEvaluator({
      maxActive: 1,
      maxQueued: 0,
      workerFactory: () => worker.asWorker(),
    });
    evaluators.push(evaluator);
    try {
      const context = { runInput: null, nodeOutputs: {} };
      const evaluation = evaluator.evaluate({ expression: '1', context });
      // Startup has its own policy; scheduler delay is not evaluation time.
      await vi.advanceTimersByTimeAsync(250);
      worker.emit('message', { ready: true });
      worker.emit('message', { started: true });
      await vi.advanceTimersByTimeAsync(EXPRESSION_POLICY.timeoutMs - 1);
      expect(worker.terminateCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(worker.terminateCalls).toBe(1);
      expect(
        await evaluator.evaluate({ expression: '2', context }),
      ).toMatchObject({ kind: 'error', limit: 'pool_capacity' });
      worker.emit('message', { ok: true, value: 99 });
      worker.termination.resolve(1);
      expect(await evaluation).toMatchObject({
        kind: 'error',
        code: 'timed_out',
      });
    } finally {
      worker.termination.resolve(1);
      await evaluator.shutdown();
      vi.useRealTimers();
    }
  });
});
