import { describe, expect, it } from 'vitest';

import { JsonataEvaluator } from '../../src/values/expressions/evaluator.js';
import { EXPRESSION_POLICY } from '../../src/values/expressions/policy.js';
import {
  evaluators,
  ControlledWorker,
  required,
} from '../support/expression-owner.js';
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
  it('retains worker ownership until deferred termination settles', async () => {
    const worker = new ControlledWorker();
    const evaluator = new JsonataEvaluator({
      maxActive: 1,
      maxQueued: 0,
      workerFactory: () => worker.asWorker(),
    });
    evaluators.push(evaluator);
    const evaluation = evaluator.evaluate({
      expression: '1',
      context: { runInput: null, nodeOutputs: {} },
    });
    worker.emit('message', { ready: true });
    worker.emit('message', { started: true });
    worker.emit('message', { ok: true, value: 1 });
    await Promise.resolve();
    await expect(
      evaluator.evaluate({
        expression: '2',
        context: { runInput: null, nodeOutputs: {} },
      }),
    ).resolves.toMatchObject({
      kind: 'error',
      limit: 'pool_capacity',
    });
    const shutdown = evaluator.shutdown();
    expect(evaluator.shutdown()).toBe(shutdown);
    let evaluationSettled = false;
    let shutdownSettled = false;
    void evaluation.then(() => {
      evaluationSettled = true;
    });
    void shutdown.then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(worker.terminateCalls).toBe(1);
    expect({ evaluationSettled, shutdownSettled }).toEqual({
      evaluationSettled: false,
      shutdownSettled: false,
    });
    worker.termination.resolve(0);
    await expect(evaluation).resolves.toEqual({
      kind: 'value',
      value: 1,
      canonicalBytes: 1,
    });
    await expect(shutdown).resolves.toBeUndefined();
  });
  it('deduplicates abort/shutdown termination and never starts queued work', async () => {
    const worker = new ControlledWorker();
    let workerCreations = 0;
    const evaluator = new JsonataEvaluator({
      maxActive: 1,
      maxQueued: 1,
      workerFactory: () => {
        workerCreations += 1;
        return worker.asWorker();
      },
    });
    evaluators.push(evaluator);
    const controller = new AbortController();
    const active = evaluator.evaluate({
      expression: '1',
      context: { runInput: null, nodeOutputs: {} },
      signal: controller.signal,
    });
    const queued = evaluator.evaluate({
      expression: '2',
      context: { runInput: null, nodeOutputs: {} },
    });
    controller.abort();
    worker.emit('message', { ok: true, value: 99 });
    const shutdown = evaluator.shutdown();
    await expect(queued).resolves.toMatchObject({
      kind: 'error',
      code: 'canceled',
    });
    await Promise.resolve();
    expect(worker.terminateCalls).toBe(1);
    expect(workerCreations).toBe(1);
    worker.termination.resolve(0);
    await expect(active).resolves.toMatchObject({
      kind: 'error',
      code: 'canceled',
    });
    await expect(shutdown).resolves.toBeUndefined();
    expect(workerCreations).toBe(1);
  });
  it('keeps evaluation outcome stable while overlapping shutdown exposes termination failure', async () => {
    const worker = new ControlledWorker();
    const evaluator = new JsonataEvaluator({
      workerFactory: () => worker.asWorker(),
    });
    evaluators.push(evaluator);
    const evaluation = evaluator.evaluate({
      expression: '1',
      context: { runInput: null, nodeOutputs: {} },
    });
    worker.emit('message', { ready: true });
    worker.emit('message', { started: true });
    worker.emit('message', { ok: true, value: 1 });
    await Promise.resolve();
    const shutdown = evaluator.shutdown();
    const cleanupFailure = new Error('termination failed');
    const shutdownAssertion = expect(shutdown).rejects.toBe(cleanupFailure);
    worker.termination.reject(cleanupFailure);
    await expect(evaluation).resolves.toEqual({
      kind: 'value',
      value: 1,
      canonicalBytes: 1,
    });
    await shutdownAssertion;
    evaluators.splice(evaluators.indexOf(evaluator), 1);
  });
  it('aggregates multiple worker cleanup failures during shutdown', async () => {
    const workers = [new ControlledWorker(), new ControlledWorker()];
    let index = 0;
    const evaluator = new JsonataEvaluator({
      maxActive: 2,
      workerFactory: () => required(workers[index++]).asWorker(),
    });
    evaluators.push(evaluator);
    const evaluations = [1, 2].map((value) =>
      evaluator.evaluate({
        expression: String(value),
        context: { runInput: null, nodeOutputs: {} },
      }),
    );
    const shutdown = evaluator.shutdown();
    const assertion = expect(shutdown).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [expect.any(Error), expect.any(Error)],
    });
    required(workers[0]).termination.reject(
      new Error('first termination failed'),
    );
    required(workers[1]).termination.reject(
      new Error('second termination failed'),
    );
    await Promise.all(
      evaluations.map(async (evaluation) =>
        expect(evaluation).resolves.toMatchObject({
          kind: 'error',
          code: 'canceled',
        }),
      ),
    );
    await assertion;
    evaluators.splice(evaluators.indexOf(evaluator), 1);
  });
  it.each([
    {
      description: 'duplicate readiness',
      messages: [{ ready: true }, { ready: true }],
      expected: 'duplicate evaluator readiness',
    },
    {
      description: 'result before start',
      messages: [{ ready: true }, { ok: true, value: 1 }],
      expected: 'evaluator result before start',
    },
    {
      description: 'duplicate start',
      messages: [{ ready: true }, { started: true }, { started: true }],
      expected: 'duplicate evaluator start',
    },
  ])(
    'rejects malformed protocol order: $description',
    async ({ messages, expected }) => {
      const worker = new ControlledWorker();
      const evaluator = new JsonataEvaluator({
        workerFactory: () => worker.asWorker(),
      });
      evaluators.push(evaluator);
      const evaluation = evaluator.evaluate({
        expression: '1',
        context: { runInput: null, nodeOutputs: {} },
      });
      for (const message of messages) worker.emit('message', message);
      worker.termination.resolve(0);
      const result = await evaluation;
      expect(result).toMatchObject({
        kind: 'error',
        code: 'evaluation_failed',
      });
      if (result.kind !== 'error')
        throw new Error('expected protocol rejection');
      expect(result.message).toContain(expected);
      expect(worker.terminateCalls).toBe(1);
    },
  );
});
