import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import {
  JsonataEvaluator,
  type ExpressionEvaluator,
} from '@pertexo/workflow-model/server';
import { describe, expect, it } from 'vitest';

import { WorkflowEngineError } from '../../../src/errors.js';
import { resolveMappedNodeInput } from '../../../src/attempt/mapping.js';

function refusing(
  error: Readonly<{
    code: 'evaluation_failed' | 'limit_exceeded' | 'timed_out' | 'unavailable';
    limit?: 'memory' | 'output_bytes' | 'pool_capacity';
  }>,
): ExpressionEvaluator {
  return {
    evaluate: () =>
      Promise.resolve({ kind: 'error', message: 'refused', ...error }),
  };
}

function resolving(evaluator: ExpressionEvaluator): Promise<unknown> {
  return resolveMappedNodeInput(
    {
      definition: { key: 'core.set', version: 1 },
      inputMappings: {
        value: { kind: 'expression', language: 'jsonata', expression: '1' },
      },
    },
    {
      runInput: {},
      completedOutputs: {},
      directUpstream: new Set(),
      signal: new AbortController().signal,
      expressionEvaluator: evaluator,
    },
  );
}

describe('what a failed expression does to its step', () => {
  it.each([
    [{ code: 'limit_exceeded', limit: 'memory' }, 'expression_limit_exceeded'],
    [
      { code: 'limit_exceeded', limit: 'output_bytes' },
      'expression_limit_exceeded',
    ],
    [{ code: 'evaluation_failed' }, 'expression_failed'],
  ] as const)('fails the step for good on %j', async (error, code) => {
    const failure: unknown = await resolving(refusing(error)).catch(
      (caught: unknown) => caught,
    );
    expect(failure).toBeInstanceOf(WorkflowEngineError);
    expect(failure).toMatchObject({ code });
  });

  it.each([
    [{ code: 'timed_out' }, 'execution.expression_timed_out'],
    [{ code: 'unavailable' }, 'execution.expression_unavailable'],
    [
      { code: 'limit_exceeded', limit: 'pool_capacity' },
      'execution.expression_unavailable',
    ],
  ] as const)('lets the step try again on %j', async (error, safeErrorCode) => {
    const failure: unknown = await resolving(refusing(error)).catch(
      (caught: unknown) => caught,
    );
    expect(failure).toBeInstanceOf(NodeExecutorFailure);
    expect(failure).toMatchObject({
      kind: 'retry',
      errorKind: 'timeout',
      possiblyDispatched: false,
      safeErrorCode,
    });
  });
});

describe('what a missing workspace variable does to its step', () => {
  it.each([
    [{ kind: 'workspace_variable', name: 'ABSENT' }],
    [{ kind: 'expression', language: 'jsonata', expression: '$vars.ABSENT' }],
  ] as const)(
    'fails the step for good, naming the cause: %j',
    async (value) => {
      const evaluator = new JsonataEvaluator();
      try {
        const failure: unknown = await resolveMappedNodeInput(
          {
            definition: { key: 'core.set', version: 1 },
            inputMappings: { value },
          },
          {
            runInput: {},
            completedOutputs: {},
            directUpstream: new Set(),
            signal: new AbortController().signal,
            expressionEvaluator: evaluator,
            variables: { PRESENT: 1 },
          },
        ).catch((caught: unknown) => caught);
        expect(failure).toBeInstanceOf(WorkflowEngineError);
        expect(failure).toMatchObject({ code: 'variable_missing' });
      } finally {
        await evaluator.shutdown();
      }
    },
  );

  it('resolves a captured value, including zero, false and empty text', async () => {
    const mapped = await resolveMappedNodeInput(
      {
        definition: { key: 'core.set', version: 1 },
        inputMappings: {
          zero: { kind: 'workspace_variable', name: 'ZERO' },
          off: { kind: 'workspace_variable', name: 'OFF' },
          empty: { kind: 'workspace_variable', name: 'EMPTY' },
        },
      },
      {
        runInput: {},
        completedOutputs: {},
        directUpstream: new Set(),
        signal: new AbortController().signal,
        variables: { ZERO: 0, OFF: false, EMPTY: '' },
      },
    );
    expect(mapped).toEqual({ zero: 0, off: false, empty: '' });
  });
});
