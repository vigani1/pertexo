import { afterAll, expect, it } from 'vitest';
import {
  JsonataEvaluator,
  type ExpressionEvaluator,
  type ExpressionLimit,
} from '@pertexo/workflow-model/server';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import { resolveSingleNodePreviewInput } from '@pertexo/workflow-engine/server';
import { describeMappingFailure } from '../../src/attempts/execution/mapping-diagnostic.js';
import { executorFailureCompletion } from '../../src/attempts/delivery/executor-failure.js';

const evaluator = new JsonataEvaluator();
afterAll(() => evaluator.shutdown());
const privateData = 'private-provider-payload-do-not-show';
async function refusal(
  expression: string,
  options: Readonly<{
    evaluator?: ExpressionEvaluator;
    runInput?: unknown;
    priorPreviewNodeId?: string;
  }> = {},
) {
  return resolveSingleNodePreviewInput({
    node: {
      id: 'step',
      definition: { key: 'core.set', version: 1 },
      configVersion: 1,
      config: {},
      connectionRefs: {},
      inputMappings: {
        harmless: { kind: 'literal', value: 'kept' },
        total: { kind: 'expression', language: 'jsonata', expression },
      },
    },
    runInput: options.runInput ?? { private: privateData },
    signal: new AbortController().signal,
    expressionEvaluator: options.evaluator ?? evaluator,
    ...(options.priorPreviewNodeId === undefined
      ? {}
      : { priorPreviewNodeId: options.priorPreviewNodeId }),
  }).catch((error: unknown) => error);
}

it.each([
  {
    dimension: 'source',
    expression: '"' + 'x'.repeat(16_384) + '"',
    options: {},
    limitCopy: 'source size limit of 16384 bytes',
    remedy: 'Shorten',
  },
  {
    dimension: 'input',
    expression: 'runInput.payload',
    options: {
      runInput: { payload: 'x'.repeat(600_000) },
      priorPreviewNodeId: 'prior',
    },
    limitCopy: 'input size limit of 1048576 bytes',
    remedy: 'Pass less',
  },
  {
    dimension: 'output',
    expression: '$join([runInput.payload, runInput.payload])',
    options: { runInput: { payload: 'x'.repeat(600_000) } },
    limitCopy: 'output size limit of 1048576 bytes',
    remedy: 'Return less',
  },
] as const)(
  'names the second field and the real $dimension limit without exposing its expression or data',
  async ({ expression, options, limitCopy, remedy }) => {
    const error = await refusal(expression, options);
    expect(describeMappingFailure(error)).toContain(
      `Expression for field "total" exceeded the ${limitCopy}.`,
    );
    expect(describeMappingFailure(error)).toContain(remedy);
    expect(describeMappingFailure(error)).not.toContain(privateData);
    expect(describeMappingFailure(error)).not.toContain(expression);
  },
);

it.each([
  ['ast_depth', 64, 'syntax depth', 'levels'],
  ['ast_nodes', 2048, 'syntax size', 'nodes'],
  ['input_depth', 64, 'input depth', 'levels'],
  ['input_members', 10000, 'input fields/items', 'members'],
  ['output_depth', 64, 'output depth', 'levels'],
  ['output_members', 10000, 'output fields/items', 'members'],
  ['memory', 64, 'heap memory', 'MiB'],
] satisfies readonly (readonly [ExpressionLimit, number, string, string])[])(
  'retains the precise %s refusal from the evaluator process',
  async (limit, maximum, dimension, unit) => {
    const error = await refusal('runInput.private', {
      evaluator: {
        evaluate: () =>
          Promise.resolve({
            kind: 'error',
            code: 'limit_exceeded',
            limit,
            message: privateData,
          }),
      },
    });
    expect(describeMappingFailure(error)).toContain(
      `Expression for field "total" exceeded the ${dimension} limit of ${String(maximum)} ${unit}.`,
    );
    expect(describeMappingFailure(error)).not.toContain(privateData);
  },
);

it.each([
  [
    { code: 'timed_out' },
    'execution.expression_timed_out',
    '100 ms evaluation limit',
  ],
  [
    { code: 'unavailable' },
    'execution.expression_unavailable',
    'evaluator was unavailable',
  ],
  [
    { code: 'limit_exceeded', limit: 'pool_capacity' },
    'execution.expression_unavailable',
    '128 waiting-evaluation limit',
  ],
] as const)(
  'keeps %j retryable and retains its field-specific reason',
  async (failure, safeErrorCode, reason) => {
    const error = await refusal('runInput.private', {
      evaluator: {
        evaluate: () =>
          Promise.resolve({ kind: 'error', message: privateData, ...failure }),
      },
    });
    expect(error).toBeInstanceOf(NodeExecutorFailure);
    const completion = executorFailureCompletion(error as NodeExecutorFailure);
    expect(completion).toMatchObject({
      status: 'executor_failure',
      failureKind: 'retry',
      safeErrorCode,
      errorSummary: expect.stringContaining(reason) as unknown,
    });
    expect(JSON.stringify(completion)).toContain('total');
    expect(JSON.stringify(completion)).not.toContain(privateData);
  },
);

it('retains the overflow reason through the worker diagnostics fence', async () => {
  const error = await refusal('1 / 0');
  expect(error).toBeInstanceOf(NodeExecutorFailure);
  expect(executorFailureCompletion(error as NodeExecutorFailure)).toMatchObject(
    {
      failureKind: 'failed',
      errorSummary:
        'Expression for field "total" returned a nonfinite number. Reduce the numeric result or check for division by zero.',
    },
  );
});

it('does not admit provider text by borrowing an expression failure code', () => {
  expect(() =>
    executorFailureCompletion(
      new NodeExecutorFailure({
        kind: 'failed',
        errorKind: 'configuration',
        possiblyDispatched: false,
        safeErrorCode: 'execution.expression_failed',
        errorSummary: privateData,
      }),
    ),
  ).toThrow();
});
