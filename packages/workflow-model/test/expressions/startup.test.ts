import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/values/json/canonical.js';
import { JsonataEvaluator } from '../../src/values/expressions/evaluator.js';
import { JSONATA_EVALUATOR_DIAGNOSTICS } from '../../src/values/expressions/policy.js';
import { evaluators } from '../support/expression-owner.js';
describe('restricted JSONata policy v1', () => {
  it('fails with a temporary error when no process can start, then recovers', async () => {
    const evaluator = new JsonataEvaluator({ maxActive: 1 });
    evaluators.push(evaluator);
    const context = { runInput: null, nodeOutputs: {} };
    const execPath = process.execPath;
    process.execPath = '/nonexistent/node';
    try {
      for (let attempt = 0; attempt < 2; attempt += 1)
        await expect(
          evaluator.evaluate({ expression: '1', context }),
        ).resolves.toMatchObject({ kind: 'error', code: 'unavailable' });
    } finally {
      process.execPath = execPath;
    }
    await expect(
      evaluator.evaluate({ expression: '1', context }),
    ).resolves.toMatchObject({ kind: 'value', value: 1 });
  });
  it('fails with a temporary error when a process starts too slowly', async () => {
    const evaluator = new JsonataEvaluator({
      maxActive: 1,
      startupTimeoutMs: 1,
    });
    evaluators.push(evaluator);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await evaluator.evaluate({
        expression: '1',
        context: { runInput: null, nodeOutputs: {} },
      });
      expect(result).toMatchObject({ kind: 'error', code: 'unavailable' });
      if (result.kind !== 'error') throw new Error('expected startup failure');
      expect(result.message).toContain('startup');
    }
    expect(evaluator.diagnostics().processStarts).toBe(2);
  });
  it('is byte-deterministic across two processes and a pool restart', async () => {
    const request = {
      expression: '{"b": runInput.b, "a": runInput.a}',
      context: { runInput: { b: 2, a: 1 }, nodeOutputs: {} },
    } as const;
    const startedAt = performance.now();
    const first = new JsonataEvaluator({ maxActive: 2 });
    evaluators.push(first);
    const repeated = await Promise.all(
      Array.from({ length: 100 }, async () => first.evaluate(request)),
    );
    expect(new Set(repeated.map((result) => JSON.stringify(result))).size).toBe(
      1,
    );
    await first.shutdown();
    const restarted = new JsonataEvaluator({ maxActive: 2 });
    evaluators.push(restarted);
    const restartedResult = await restarted.evaluate(request);
    expect(restartedResult).toEqual(repeated[0]);
    expect(restartedResult.kind).toBe('value');
    if (restartedResult.kind !== 'value') throw new Error('expected a value');
    const resultBytes = canonicalJson(restartedResult.value);
    const checksum = createHash('sha256').update(resultBytes).digest('hex');
    const elapsedMs = performance.now() - startedAt;
    expect(resultBytes).toBe('{"a":1,"b":2}');
    expect(checksum).toBe(
      '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777',
    );
    console.info(
      'jsonata_engine_gate',
      JSON.stringify({
        elapsedMs: Number(elapsedMs.toFixed(2)),
        resultChecksumSha256: checksum,
        evaluatorPackage: JSONATA_EVALUATOR_DIAGNOSTICS.library,
        evaluatorPackageVersion: JSONATA_EVALUATOR_DIAGNOSTICS.libraryVersion,
        evaluations: 101,
        isolation: first.diagnostics().isolation,
        processStarts: first.diagnostics().processStarts,
        peakProcesses: first.diagnostics().peakProcesses,
        poolRestarted: true,
      }),
    );
  }, 30_000);
});
