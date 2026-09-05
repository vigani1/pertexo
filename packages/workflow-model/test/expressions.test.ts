import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import jsonata from 'jsonata';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, type JsonValue } from '../src/canonical-json.js';
import {
  EXPRESSION_POLICY_V1,
  JSONATA_EVALUATOR_DIAGNOSTICS,
  JsonataEvaluator,
  validateExpression,
} from '../src/expressions.js';

const evaluators: JsonataEvaluator[] = [];
afterEach(async () => {
  await Promise.all(evaluators.splice(0).map(async (e) => e.shutdown()));
});

describe('restricted JSONata policy v1', () => {
  it('executes the compiled and typechecked worker artifact', async () => {
    const worker = new Worker(
      new URL('../dist/expression-worker-runtime.js', import.meta.url),
    );
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        worker.once('error', reject);
        worker.on('message', (message: unknown) => {
          if (
            message !== null &&
            typeof message === 'object' &&
            Reflect.get(message, 'ready') === true
          ) {
            worker.postMessage({
              expression: 'runInput.value + 1',
              context: { runInput: { value: 1 }, nodeOutputs: {} },
            });
          } else if (
            message !== null &&
            typeof message === 'object' &&
            Object.hasOwn(message, 'ok')
          ) {
            resolve(message);
          }
        });
      });
      expect(result).toEqual(
        expect.objectContaining({ ok: true, missing: false, value: 2 }),
      );
    } finally {
      await worker.terminate();
    }
  });

  it('keeps the pinned JSONata AST contract behind the policy boundary', () => {
    expect(JSONATA_EVALUATOR_DIAGNOSTICS.libraryVersion).toBe('2.2.2');
    expect(jsonata('runInput.name').ast()).toMatchObject({
      type: 'path',
      steps: [
        { type: 'name', value: 'runInput' },
        { type: 'name', value: 'name' },
      ],
    });
    expect(jsonata('$uppercase(runInput.name)').ast()).toMatchObject({
      type: 'function',
      procedure: { type: 'variable', value: 'uppercase' },
      arguments: [{ type: 'path' }],
    });
    expect(validateExpression('runInput.name', 1)).toEqual({ kind: 'valid' });
  });

  it('accepts navigation/construction/pure built-ins and rejects capabilities before execution', () => {
    expect(
      validateExpression(
        '{"name": $uppercase(runInput.name), "n": $sum([1,2,3])}',
        1,
      ),
    ).toEqual({ kind: 'valid' });
    for (const source of [
      '$eval("1")',
      '$now()',
      'function($x){$x}',
      '$x := 1',
      '/x/',
      'runInput.**',
      '$map([1], $string)',
      'process.env',
      'require("node:fs")',
      '$fetch("https://example.com")',
      'constructor',
      'globalThis.fetch',
    ]) {
      expect(validateExpression(source, 1)).toEqual(
        expect.objectContaining({
          kind: 'error',
          code: 'disallowed_construct',
        }),
      );
    }
    expect(validateExpression('runInput.constructor', 1)).toEqual({
      kind: 'valid',
    });
    for (const source of [
      'runInput@$focus',
      'runInput#$index',
      'runInput{key: value}',
    ]) {
      expect(validateExpression(source, 1)).toEqual(
        expect.objectContaining({
          kind: 'error',
          code: 'disallowed_construct',
        }),
      );
    }
    expect(validateExpression('x', 999)).toEqual(
      expect.objectContaining({ kind: 'error', code: 'invalid_expression' }),
    );
  });
  it('accepts exact expression AST limits and rejects one unit over', () => {
    expect(
      validateExpression(
        `1${' '.repeat(EXPRESSION_POLICY_V1.expressionBytes - 1)}`,
        1,
      ),
    ).toEqual({ kind: 'valid' });
    expect(
      validateExpression(
        `1${' '.repeat(EXPRESSION_POLICY_V1.expressionBytes)}`,
        1,
      ),
    ).toEqual(
      expect.objectContaining({ kind: 'error', limit: 'expression_bytes' }),
    );
    expect(
      validateExpression(Array.from({ length: 64 }, () => '1').join('+'), 1),
    ).toEqual({ kind: 'valid' });
    expect(
      validateExpression(Array.from({ length: 65 }, () => '1').join('+'), 1),
    ).toEqual(expect.objectContaining({ kind: 'error', limit: 'ast_depth' }));
    expect(
      validateExpression(
        `[${Array.from({ length: 2047 }, () => '1').join(',')}]`,
        1,
      ),
    ).toEqual({ kind: 'valid' });
    expect(
      validateExpression(
        `[${Array.from({ length: 2048 }, () => '1').join(',')}]`,
        1,
      ),
    ).toEqual(expect.objectContaining({ kind: 'error', limit: 'ast_nodes' }));
  });
  it('uses the production worker for value, missing, malformed, and preview/runtime parity', async () => {
    const evaluator = new JsonataEvaluator();
    evaluators.push(evaluator);
    const context = { runInput: { name: 'Ada' }, nodeOutputs: {} };
    const expected = { kind: 'value', value: 'ADA', canonicalBytes: 5 };
    expect(
      await evaluator.evaluate({
        expression: '$uppercase(runInput.name)',
        policyVersion: 1,
        context,
      }),
    ).toEqual(expected);
    expect(
      await evaluator.preview({
        expression: '$uppercase(runInput.name)',
        policyVersion: 1,
        context,
      }),
    ).toEqual(expected);
    expect(
      await evaluator.runtime({
        expression: '$uppercase(runInput.name)',
        policyVersion: 1,
        context,
      }),
    ).toEqual(expected);
    expect(
      await evaluator.evaluate({
        expression: 'runInput.absent',
        policyVersion: 1,
        context,
      }),
    ).toEqual({ kind: 'missing' });
    expect(
      (await evaluator.evaluate({ expression: '(', policyVersion: 1, context }))
        .kind,
    ).toBe('error');
  });
  it('projects evaluator context to the two declared fields before isolation', async () => {
    const evaluator = new JsonataEvaluator();
    evaluators.push(evaluator);
    const context = {
      runInput: { name: 'Ada' },
      nodeOutputs: {},
      secret: 'must never reach JSONata',
    } as never;
    expect(
      await evaluator.evaluate({
        expression: '$keys($)',
        policyVersion: 1,
        context,
      }),
    ).toEqual(
      expect.objectContaining({
        kind: 'value',
        value: ['nodeOutputs', 'runInput'],
      }),
    );
  });
  it('supports the allowed navigation, filter, construction, and operator profile', async () => {
    const evaluator = new JsonataEvaluator();
    evaluators.push(evaluator);
    const context = {
      runInput: { items: [{ n: 1 }, { n: 3 }] },
      nodeOutputs: {},
    };
    const expression =
      '{"selected": runInput.items[n > 1].n, "math": 2 * 3, "text": "a" & "b", "choice": true ? "yes" : "no"}';
    expect(
      await evaluator.evaluate({ expression, policyVersion: 1, context }),
    ).toEqual(
      expect.objectContaining({
        kind: 'value',
        value: { choice: 'yes', math: 6, selected: 3, text: 'ab' },
      }),
    );
  });
  it('executes every allowlisted pure built-in with a known result', async () => {
    const evaluator = new JsonataEvaluator();
    evaluators.push(evaluator);
    const context = { runInput: { x: 1 }, nodeOutputs: {} };
    const cases: readonly (readonly [string, unknown])[] = [
      ['$string(1)', '1'],
      ['$number("2")', 2],
      ['$boolean(1)', true],
      ['$not(false)', true],
      ['$exists(runInput.x)', true],
      ['$type(1)', 'number'],
      ['$count([1,2])', 2],
      ['$sum([1,2,3])', 6],
      ['$min([1,2])', 1],
      ['$max([1,2])', 2],
      ['$average([1,2,3])', 2],
      ['$append([1],[2])', [1, 2]],
      ['$reverse([1,2])', [2, 1]],
      ['$distinct([1,1,2])', [1, 2]],
      ['$join(["a","b"], "-")', 'a-b'],
      ['$substring("abcd",1,2)', 'bc'],
      ['$substringBefore("a:b", ":")', 'a'],
      ['$substringAfter("a:b", ":")', 'b'],
      ['$uppercase("Ada")', 'ADA'],
      ['$lowercase("Ada")', 'ada'],
      ['$length("Ada")', 3],
      ['$trim("  a  ")', 'a'],
      ['$pad("a",3,".")', 'a..'],
      ['$keys({"a":1,"b":2})', ['a', 'b']],
      ['$lookup({"a":1},"a")', 1],
      ['$merge([{"a":1},{"b":2}])', { a: 1, b: 2 }],
      ['$spread({"a":1})', { a: 1 }],
    ];
    const results = await Promise.all(
      cases.map(async ([expression]) =>
        evaluator.evaluate({ expression, policyVersion: 1, context }),
      ),
    );
    results.forEach((result, index) => {
      expect(result).toEqual(
        expect.objectContaining({ kind: 'value', value: cases[index]?.[1] }),
      );
    });
  });
  it('enforces input/output limits, cancellation, pool admission, and restart', async () => {
    const evaluator = new JsonataEvaluator({ maxActive: 1, maxQueued: 0 });
    evaluators.push(evaluator);
    const context = {
      runInput: { text: 'x'.repeat(EXPRESSION_POLICY_V1.inputBytes) },
      nodeOutputs: {},
    };
    expect(
      await evaluator.evaluate({ expression: '1', policyVersion: 1, context }),
    ).toEqual(expect.objectContaining({ kind: 'error', limit: 'input_bytes' }));
    const controller = new AbortController();
    controller.abort();
    expect(
      await evaluator.evaluate({
        expression: '1',
        policyVersion: 1,
        context: { runInput: null, nodeOutputs: {} },
        signal: controller.signal,
      }),
    ).toEqual(expect.objectContaining({ kind: 'error', code: 'canceled' }));
    expect(
      await evaluator.evaluate({
        expression: '"x"',
        policyVersion: 1,
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
      runInput: 'x'.repeat(EXPRESSION_POLICY_V1.inputBytes - overhead),
      nodeOutputs: {},
    };
    expect(
      await evaluator.evaluate({
        expression: '1',
        policyVersion: 1,
        context: exactContext,
      }),
    ).toEqual({ kind: 'value', value: 1, canonicalBytes: 1 });
    expect(
      await evaluator.evaluate({
        expression: '1',
        policyVersion: 1,
        context: { ...exactContext, runInput: `${exactContext.runInput}x` },
      }),
    ).toEqual(expect.objectContaining({ kind: 'error', limit: 'input_bytes' }));
    expect(
      await evaluator.evaluate({
        expression: '[1..10000]',
        policyVersion: 1,
        context: empty,
      }),
    ).toEqual(expect.objectContaining({ kind: 'value' }));
    expect(
      await evaluator.evaluate({
        expression: '[1..10001]',
        policyVersion: 1,
        context: empty,
      }),
    ).toEqual(
      expect.objectContaining({ kind: 'error', limit: 'output_members' }),
    );
    expect(
      await evaluator.evaluate({
        expression: '$pad("",1048574,"x")',
        policyVersion: 1,
        context: empty,
      }),
    ).toEqual(
      expect.objectContaining({ kind: 'value', canonicalBytes: 1048576 }),
    );
    expect(
      await evaluator.evaluate({
        expression: '$pad("",1048575,"x")',
        policyVersion: 1,
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
        policyVersion: 1,
        context: exactDepth,
      }),
    ).toEqual({ kind: 'value', value: 1, canonicalBytes: 1 });
    expect(
      await evaluator.evaluate({
        expression: '1',
        policyVersion: 1,
        context: { runInput: nested(64), nodeOutputs: {} },
      }),
    ).toEqual(expect.objectContaining({ kind: 'error', limit: 'input_depth' }));
    expect(
      await evaluator.evaluate({
        expression: '1',
        policyVersion: 1,
        context: {
          runInput: Array.from({ length: 9_998 }, () => null),
          nodeOutputs: {},
        },
      }),
    ).toEqual({ kind: 'value', value: 1, canonicalBytes: 1 });
    expect(
      await evaluator.evaluate({
        expression: '1',
        policyVersion: 1,
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
        policyVersion: 1,
        context,
      }),
    ).toEqual(expect.objectContaining({ kind: 'value' }));
    expect(
      await evaluator.evaluate({
        expression: '{"x": {"y": runInput}}',
        policyVersion: 1,
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
    const started = performance.now();
    const expensive = evaluator.evaluate({
      expression: '$distinct([1..50000])',
      policyVersion: 1,
      context,
    });
    expect(
      await evaluator.evaluate({ expression: '1', policyVersion: 1, context }),
    ).toEqual(
      expect.objectContaining({ kind: 'error', limit: 'pool_capacity' }),
    );
    expect(await expensive).toEqual(
      expect.objectContaining({ kind: 'error', code: 'timed_out' }),
    );
    expect(performance.now() - started).toBeLessThan(250);
    expect(
      await evaluator.evaluate({ expression: '2', policyVersion: 1, context }),
    ).toEqual({ kind: 'value', value: 2, canonicalBytes: 1 });
  });
  it('cancels queued and active evaluation without exposing a late value', async () => {
    const evaluator = new JsonataEvaluator({ maxActive: 1, maxQueued: 1 });
    evaluators.push(evaluator);
    const context = { runInput: null, nodeOutputs: {} };
    const activeController = new AbortController();
    const active = evaluator.evaluate({
      expression: '$distinct([1..50000])',
      policyVersion: 1,
      context,
      signal: activeController.signal,
    });
    const queuedController = new AbortController();
    const queued = evaluator.evaluate({
      expression: '7',
      policyVersion: 1,
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
          maxActive: EXPRESSION_POLICY_V1.maxActive + 1,
        }),
    ).toThrow('bounds');
    const evaluator = new JsonataEvaluator({ maxActive: 1 });
    evaluators.push(evaluator);
    const active = evaluator.evaluate({
      expression: '$distinct([1..50000])',
      policyVersion: 1,
      context: { runInput: null, nodeOutputs: {} },
    });
    await evaluator.shutdown();
    expect(await active).toEqual(
      expect.objectContaining({ kind: 'error', code: 'canceled' }),
    );
  });
  it('returns typed failures and releases capacity after worker setup and startup failures', async () => {
    const constructionFailure = new JsonataEvaluator({
      maxActive: 1,
      workerFactory: () => {
        throw new Error('construction unavailable');
      },
    });
    evaluators.push(constructionFailure);
    for (let attempt = 0; attempt < 2; attempt += 1)
      await expect(
        constructionFailure.evaluate({
          expression: '1',
          policyVersion: 1,
          context: { runInput: null, nodeOutputs: {} },
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          kind: 'error',
          code: 'evaluation_failed',
        }),
      );

    const startupFailure = new JsonataEvaluator({
      maxActive: 1,
      startupTimeoutMs: 10,
      workerFactory: () =>
        new Worker('setInterval(() => {}, 1000)', { eval: true }),
    });
    evaluators.push(startupFailure);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await startupFailure.evaluate({
        expression: '1',
        policyVersion: 1,
        context: { runInput: null, nodeOutputs: {} },
      });
      expect(result).toEqual(
        expect.objectContaining({
          kind: 'error',
          code: 'evaluation_failed',
        }),
      );
      if (result.kind !== 'error') throw new Error('expected startup failure');
      expect(result.message).toContain('startup');
    }
    expect(startupFailure.diagnostics().workerCreations).toBe(2);
  });
  it('terminates a worker that becomes ready but never starts evaluation', async () => {
    const evaluator = new JsonataEvaluator({
      maxActive: 1,
      startupTimeoutMs: 10,
      workerFactory: () =>
        new Worker(
          'const { parentPort } = require("node:worker_threads"); parentPort.postMessage({ ready: true }); parentPort.on("message", () => {});',
          { eval: true },
        ),
    });
    evaluators.push(evaluator);

    const result = await evaluator.evaluate({
      expression: '1',
      policyVersion: 1,
      context: { runInput: null, nodeOutputs: {} },
    });
    expect(result).toMatchObject({
      kind: 'error',
      code: 'evaluation_failed',
    });
    if (result.kind !== 'error') throw new Error('Expected evaluator failure');
    expect(result.message).toContain('startup');
    expect(evaluator.diagnostics().workerCreations).toBe(1);
  });
  it('is byte-deterministic across two workers and a pool restart', async () => {
    const request = {
      expression: '{"b": runInput.b, "a": runInput.a}',
      policyVersion: 1,
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
    expect(elapsedMs).toBeGreaterThan(0);
    console.info(
      'jsonata_engine_gate',
      JSON.stringify({
        elapsedMs: Number(elapsedMs.toFixed(2)),
        resultChecksumSha256: checksum,
        evaluatorPackage: JSONATA_EVALUATOR_DIAGNOSTICS.library,
        evaluatorPackageVersion: JSONATA_EVALUATOR_DIAGNOSTICS.libraryVersion,
        policyVersion: JSONATA_EVALUATOR_DIAGNOSTICS.policyVersion,
        evaluations: 101,
        isolation: first.diagnostics().isolation,
        workerCreations: first.diagnostics().workerCreations,
        peakWorkers: first.diagnostics().peakWorkers,
        poolRestarted: true,
      }),
    );
  });
});
