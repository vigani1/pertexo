import jsonata from 'jsonata';
import { remapCallbackReferences } from '../../src/flow/callbacks/references.js';
import { afterEach, expect, it } from 'vitest';
import { JsonataEvaluator } from '../../src/values/expressions/evaluator.js';
import { inspectExpression } from '../../src/values/expressions/policy.js';

const evaluators: JsonataEvaluator[] = [];
afterEach(async () => {
  await Promise.all(
    evaluators.splice(0).map((evaluator) => evaluator.shutdown()),
  );
});
it.each([
  '$lookup($execution.callbacks,"wait-1").url',
  '$execution.callbacks.wait.url',
])('resolves a static callback reference: %s', async (expression) => {
  const inspected = inspectExpression(expression);
  expect(inspected.kind).toBe('valid');
  const evaluator = new JsonataEvaluator();
  evaluators.push(evaluator);
  expect(
    await evaluator.evaluate({
      expression,
      context: {
        runInput: {},
        nodeOutputs: {},
        execution: {
          callbacks: {
            wait: { url: 'https://example.test/callback' },
            'wait-1': { url: 'https://example.test/callback' },
          },
        },
      },
    }),
  ).toMatchObject({ kind: 'value', value: 'https://example.test/callback' });
});
it('keeps callback leaves in literal objects and arrays alongside ordinary mappings', async () => {
  const expression =
    '{"callback":$lookup($execution.callbacks,"wait-1").url,"authorization":[$lookup($execution.callbacks,"wait-1").secret],"id":runInput.id}';
  expect(inspectExpression(expression)).toMatchObject({
    kind: 'valid',
    callbacks: [
      { nodeId: 'wait-1', field: 'url' },
      { nodeId: 'wait-1', field: 'secret' },
    ],
  });
  const evaluator = new JsonataEvaluator();
  evaluators.push(evaluator);
  expect(
    await evaluator.evaluate({
      expression,
      context: {
        runInput: { id: 17 },
        nodeOutputs: {},
        execution: {
          callbacks: {
            'wait-1': {
              url: 'https://example.test/callback',
              secret: 'fixture-secret',
            },
          },
        },
      },
    }),
  ).toMatchObject({
    kind: 'value',
    value: {
      callback: 'https://example.test/callback',
      authorization: ['fixture-secret'],
      id: 17,
    },
  });
});
it.each([
  '$execution',
  '$execution.callbacks',
  '$lookup($execution.callbacks,runInput.wait).url',
  '$uppercase($lookup($execution.callbacks,"wait-1").url)',
  '$lookup($execution.callbacks,"wait-1").url & "suffix"',
  '$lookup($execution.callbacks,"wait-1").url[0]',
  '$string({"callback":$lookup($execution.callbacks,"wait-1").url})',
  '{$lookup($execution.callbacks,"wait-1").url:1}',
])(
  'refuses whole, dynamic or transformed callback credentials: %s',
  (expression) => {
    expect(inspectExpression(expression).kind).toBe('error');
  },
);
it('refuses unavailable callback material without exposing a credential or evaluating a provider call', async () => {
  const evaluator = new JsonataEvaluator();
  evaluators.push(evaluator);
  expect(
    await evaluator.evaluate({
      expression: '$lookup($execution.callbacks,"wait-1").url',
      context: { runInput: {}, nodeOutputs: {} },
    }),
  ).toMatchObject({ kind: 'error', code: 'callback_unavailable' });
});

it('preserves the normal object-row expression serialization around callback leaves', () => {
  expect(
    inspectExpression(
      '{"callback": ($lookup($execution.callbacks,"wait-1").url)}',
    ),
  ).toMatchObject({
    kind: 'valid',
    callbacks: [{ nodeId: 'wait-1', field: 'url' }],
  });
});

it('copies static Wait bindings without rewriting unrelated text, expressions or unselected targets', () => {
  const original =
    '{"url":($lookup($execution.callbacks,"wait-1").url),"secret":$execution.callbacks.wait.secret,"text":"wait-1"}';
  const rewritten = remapCallbackReferences(
    original,
    jsonata(original).ast(),
    new Map([['wait-1', 'copied-wait']]),
  );
  expect(rewritten).toBe(
    original.replace('callbacks,"wait-1"', 'callbacks,"copied-wait"'),
  );
  expect(inspectExpression(rewritten)).toMatchObject({
    kind: 'valid',
    callbacks: [
      { nodeId: 'copied-wait', field: 'url' },
      { nodeId: 'wait', field: 'secret' },
    ],
  });
});
