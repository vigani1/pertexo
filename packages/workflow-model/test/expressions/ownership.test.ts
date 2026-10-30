import { describe, expect, it } from 'vitest';

import { JsonataEvaluator } from '../../src/values/expressions/evaluator.js';
import { EXPRESSION_POLICY } from '../../src/values/expressions/policy.js';
import { evaluators } from '../support/expression-owner.js';
describe('restricted JSONata policy v1', () => {
  it('cancels queued and active evaluation without exposing a late value', async () => {
    const evaluator = new JsonataEvaluator({ maxActive: 1, maxQueued: 1 });
    evaluators.push(evaluator);
    const context = { runInput: null, nodeOutputs: {} };
    const activeController = new AbortController();
    const active = evaluator.evaluate({
      expression: '$distinct([1..50000])',
      context,
      signal: activeController.signal,
    });
    const queuedController = new AbortController();
    const queued = evaluator.evaluate({
      expression: '7',
      context,
      signal: queuedController.signal,
    });
    queuedController.abort();
    activeController.abort();
    expect(await queued).toEqual(
      expect.objectContaining({ kind: 'error', code: 'canceled' }),
    );
    expect(await active).toEqual(
      expect.objectContaining({ kind: 'error', code: 'canceled' }),
    );
  });
  it('terminates active work during shutdown and rejects out-of-policy pool sizes', async () => {
    expect(
      () =>
        new JsonataEvaluator({
          maxActive: EXPRESSION_POLICY.maxActive + 1,
        }),
    ).toThrow('bounds');
    const evaluator = new JsonataEvaluator({ maxActive: 1 });
    evaluators.push(evaluator);
    const active = evaluator.evaluate({
      expression: '$distinct([1..50000])',
      context: { runInput: null, nodeOutputs: {} },
    });
    await evaluator.shutdown();
    expect(await active).toEqual(
      expect.objectContaining({ kind: 'error', code: 'canceled' }),
    );
  });
  it('stops once, however often it is asked, and never starts queued work', async () => {
    const evaluator = new JsonataEvaluator({ maxActive: 1, maxQueued: 1 });
    evaluators.push(evaluator);
    const controller = new AbortController();
    const active = evaluator.evaluate({
      expression: '$distinct([1..50000])',
      context: { runInput: null, nodeOutputs: {} },
      signal: controller.signal,
    });
    const queued = evaluator.evaluate({
      expression: '2',
      context: { runInput: null, nodeOutputs: {} },
    });
    controller.abort();
    const shutdown = evaluator.shutdown();
    expect(evaluator.shutdown()).toBe(shutdown);
    await expect(queued).resolves.toMatchObject({
      kind: 'error',
      code: 'canceled',
    });
    await expect(active).resolves.toMatchObject({
      kind: 'error',
      code: 'canceled',
    });
    await expect(shutdown).resolves.toBeUndefined();
    expect(evaluator.diagnostics().processStarts).toBe(1);
  });
  it('finishes a value it already has while shutting down', async () => {
    const evaluator = new JsonataEvaluator();
    evaluators.push(evaluator);
    const context = { runInput: null, nodeOutputs: {} };
    expect(
      await evaluator.evaluate({ expression: '1', context }),
    ).toMatchObject({ kind: 'value', value: 1 });
    await evaluator.shutdown();
    expect(
      await evaluator.evaluate({ expression: '1', context }),
    ).toMatchObject({ kind: 'error', code: 'canceled' });
  });
});
