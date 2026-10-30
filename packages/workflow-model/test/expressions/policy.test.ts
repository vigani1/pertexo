import jsonata from 'jsonata';
import { describe, expect, it } from 'vitest';

import { JsonataEvaluator } from '../../src/values/expressions/evaluator.js';
import {
  EXPRESSION_POLICY,
  JSONATA_EVALUATOR_DIAGNOSTICS,
  validateExpression,
} from '../../src/values/expressions/policy.js';
import { evaluators } from '../support/expression-owner.js';
describe('restricted JSONata policy v1', () => {
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
    expect(validateExpression('runInput.name')).toEqual({ kind: 'valid' });
  });
  it('accepts navigation/construction/pure built-ins and rejects capabilities before execution', () => {
    expect(
      validateExpression(
        '{"name": $uppercase(runInput.name), "n": $sum([1,2,3])}',
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
      expect(validateExpression(source)).toEqual(
        expect.objectContaining({
          kind: 'error',
          code: 'disallowed_construct',
        }),
      );
    }
    expect(validateExpression('runInput.constructor')).toEqual({
      kind: 'valid',
    });
    for (const source of [
      'runInput@$focus',
      'runInput#$index',
      'runInput{key: value}',
    ]) {
      expect(validateExpression(source)).toEqual(
        expect.objectContaining({
          kind: 'error',
          code: 'disallowed_construct',
        }),
      );
    }
  });
  it('accepts exact expression AST limits and rejects one unit over', () => {
    expect(
      validateExpression(
        `1${' '.repeat(EXPRESSION_POLICY.expressionBytes - 1)}`,
      ),
    ).toEqual({ kind: 'valid' });
    expect(
      validateExpression(`1${' '.repeat(EXPRESSION_POLICY.expressionBytes)}`),
    ).toEqual(
      expect.objectContaining({ kind: 'error', limit: 'expression_bytes' }),
    );
    expect(
      validateExpression(Array.from({ length: 64 }, () => '1').join('+')),
    ).toEqual({ kind: 'valid' });
    expect(
      validateExpression(Array.from({ length: 65 }, () => '1').join('+')),
    ).toEqual(expect.objectContaining({ kind: 'error', limit: 'ast_depth' }));
    expect(
      validateExpression(
        `[${Array.from({ length: 2047 }, () => '1').join(',')}]`,
      ),
    ).toEqual({ kind: 'valid' });
    expect(
      validateExpression(
        `[${Array.from({ length: 2048 }, () => '1').join(',')}]`,
      ),
    ).toEqual(expect.objectContaining({ kind: 'error', limit: 'ast_nodes' }));
  });
  it('uses the production worker for value, missing, and malformed expressions', async () => {
    const evaluator = new JsonataEvaluator();
    evaluators.push(evaluator);
    const context = { runInput: { name: 'Ada' }, nodeOutputs: {} };
    const expected = { kind: 'value', value: 'ADA', canonicalBytes: 5 };
    // Matches the authoring UI's example; context is not a mapped-input object.
    expect(
      await evaluator.evaluate({
        expression: 'runInput.amount > 5000',
        context: { runInput: { amount: 6000 }, nodeOutputs: {} },
      }),
    ).toEqual({ kind: 'value', value: true, canonicalBytes: 4 });
    expect(
      await evaluator.evaluate({
        expression: '$uppercase(runInput.name)',
        context,
      }),
    ).toEqual(expected);
    expect(
      await evaluator.evaluate({
        expression: 'runInput.absent',
        context,
      }),
    ).toEqual({ kind: 'missing' });
    expect((await evaluator.evaluate({ expression: '(', context })).kind).toBe(
      'error',
    );
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
        context,
      }),
    ).toEqual(
      expect.objectContaining({
        kind: 'value',
        value: ['runInput', 'nodeOutputs'],
      }),
    );
  });
  it('keeps the key order of the data it reads and returns', async () => {
    const evaluator = new JsonataEvaluator();
    evaluators.push(evaluator);
    const context = {
      runInput: {
        name: 'Ada',
        qty: 2,
        address: { zip: '10115', city: 'Berlin' },
      },
      nodeOutputs: {},
    };
    const result = await evaluator.evaluate({
      expression: '{ "row": runInput, "keys": $keys(runInput.address) }',
      context,
    });
    expect(result.kind === 'value' && JSON.stringify(result.value)).toBe(
      '{"row":{"name":"Ada","qty":2,"address":{"zip":"10115","city":"Berlin"}},"keys":["zip","city"]}',
    );
  });
  it('rejects accessor-bearing and hostile contexts before any process starts', async () => {
    let getterCalls = 0;
    const evaluator = new JsonataEvaluator();
    evaluators.push(evaluator);
    const topLevelGetter = {
      get runInput() {
        getterCalls += 1;
        throw new Error('must not execute');
      },
      nodeOutputs: {},
    };
    const nestedGetter = {
      runInput: {
        get secret() {
          getterCalls += 1;
          throw new Error('must not execute');
        },
      },
      nodeOutputs: {},
    };
    const descriptorTrap = new Proxy(
      { runInput: null, nodeOutputs: {} },
      {
        getOwnPropertyDescriptor() {
          throw new Proxy(new Error('descriptor trap'), {
            getPrototypeOf() {
              throw new Error('secondary trap');
            },
          });
        },
      },
    );
    const revoked = Proxy.revocable({ runInput: null, nodeOutputs: {} }, {});
    revoked.revoke();
    for (const context of [
      topLevelGetter,
      nestedGetter,
      descriptorTrap,
      revoked.proxy,
    ])
      await expect(
        evaluator.evaluate({
          expression: '1',
          context: context as never,
        }),
      ).resolves.toMatchObject({
        kind: 'error',
        code: 'evaluation_failed',
        message: 'invalid expression context',
      });
    expect(getterCalls).toBe(0);
    expect(evaluator.diagnostics().processStarts).toBe(0);
  });
  it('accepts null-prototype context records through the no-accessor contract', async () => {
    const evaluator = new JsonataEvaluator();
    evaluators.push(evaluator);
    const context = Object.create(null) as Record<string, unknown>;
    context.runInput = { value: 2 };
    context.nodeOutputs = {};
    await expect(
      evaluator.evaluate({
        expression: 'runInput.value',
        context: context as never,
      }),
    ).resolves.toEqual({ kind: 'value', value: 2, canonicalBytes: 1 });
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
    expect(await evaluator.evaluate({ expression, context })).toEqual(
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
        evaluator.evaluate({ expression, context }),
      ),
    );
    results.forEach((result, index) => {
      expect(result).toEqual(
        expect.objectContaining({ kind: 'value', value: cases[index]?.[1] }),
      );
    });
  });
});
