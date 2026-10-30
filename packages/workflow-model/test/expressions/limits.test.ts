import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../src/values/json/canonical.js';
import { JsonataEvaluator } from '../../src/values/expressions/evaluator.js';
import { EXPRESSION_POLICY } from '../../src/values/expressions/policy.js';
import { evaluators } from '../support/expression-owner.js';
/** Only the one evaluator a test owns has child processes here. */
function evaluationProcessId(): number {
  const children = execFileSync('pgrep', ['-P', String(process.pid)], {
    encoding: 'utf8',
  });
  return Number(children.trim().split('\n').at(-1));
}

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
    const evaluator = new JsonataEvaluator({ maxActive: 1, maxQueued: 0 });
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
    expect(await evaluator.evaluate({ expression: '2', context })).toEqual({
      kind: 'value',
      value: 2,
      canonicalBytes: 1,
    });
    expect(evaluator.diagnostics()).toMatchObject({
      processStarts: 2,
      peakProcesses: 1,
    });
  });
  it('reports a process that crashed mid-evaluation as the expression exceeding memory', async () => {
    const evaluator = new JsonataEvaluator({ maxActive: 1 });
    evaluators.push(evaluator);
    const context = { runInput: null, nodeOutputs: {} };
    await evaluator.evaluate({ expression: '1', context });
    const evaluation = evaluator.evaluate({
      expression: '$distinct([1..50000])',
      context,
    });
    // How V8 ends a process out of memory; which bomb gets there first is a race.
    process.kill(evaluationProcessId(), 'SIGABRT');
    expect(await evaluation).toMatchObject({
      kind: 'error',
      code: 'limit_exceeded',
      limit: 'memory',
    });
    expect(await evaluator.evaluate({ expression: '3', context })).toEqual({
      kind: 'value',
      value: 3,
      canonicalBytes: 1,
    });
  });
  it('reports a process stopped from outside as temporary, not as the expression', async () => {
    const evaluator = new JsonataEvaluator({ maxActive: 1 });
    evaluators.push(evaluator);
    const context = { runInput: null, nodeOutputs: {} };
    await evaluator.evaluate({ expression: '1', context });
    const evaluation = evaluator.evaluate({
      expression: '$distinct([1..50000])',
      context,
    });
    process.kill(evaluationProcessId(), 'SIGKILL');
    expect(await evaluation).toMatchObject({
      kind: 'error',
      code: 'unavailable',
    });
    expect(await evaluator.evaluate({ expression: '3', context })).toEqual({
      kind: 'value',
      value: 3,
      canonicalBytes: 1,
    });
  });
  it('counts evaluation time from the start of evaluation, not from the request', async () => {
    const evaluator = new JsonataEvaluator({ maxActive: 1 });
    evaluators.push(evaluator);
    const evaluation = evaluator.evaluate({
      expression: '4',
      context: { runInput: null, nodeOutputs: {} },
    });
    // A loaded host: nothing happens here for longer than the evaluation limit.
    const blockedUntil = performance.now() + EXPRESSION_POLICY.timeoutMs * 3;
    while (performance.now() < blockedUntil);
    expect(await evaluation).toEqual({
      kind: 'value',
      value: 4,
      canonicalBytes: 1,
    });
  });
  it('uses one process for a run of evaluations', async () => {
    const evaluator = new JsonataEvaluator();
    evaluators.push(evaluator);
    const context = { runInput: { a: 1 }, nodeOutputs: {} };
    const startedAt = performance.now();
    for (let index = 0; index < 500; index += 1)
      expect(
        await evaluator.evaluate({ expression: 'runInput.a', context }),
      ).toMatchObject({ kind: 'value', value: 1 });
    expect(evaluator.diagnostics().processStarts).toBe(1);
    console.info(
      'jsonata_pool_gate',
      JSON.stringify({
        evaluations: 500,
        elapsedMs: Number((performance.now() - startedAt).toFixed(2)),
      }),
    );
  });
  it('leaves nothing behind for the next evaluation in a shared process', async () => {
    const evaluator = new JsonataEvaluator({ maxActive: 1 });
    evaluators.push(evaluator);
    const context = { runInput: null, nodeOutputs: {} };
    for (const expression of [
      '$merge([{"__proto__":{"polluted":"yes"}}])',
      '{"__proto__":{"polluted":"yes"}}',
      '$spread({"__proto__":{"polluted":"yes"}})',
    ])
      await evaluator.evaluate({ expression, context });
    expect(evaluator.diagnostics().processStarts).toBe(1);
    expect(
      await evaluator.evaluate({
        expression: '{"probe":1}.polluted',
        context,
      }),
    ).toEqual({ kind: 'missing' });
    expect(
      await evaluator.evaluate({
        expression: '[1].polluted',
        context,
      }),
    ).toEqual({ kind: 'missing' });
  });
});
