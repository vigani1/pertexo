import { describe, expect, it } from 'vitest';
import type { JsonataEvaluator } from '../src/expressions.js';
import { resolveJsonPath, resolveValueSource } from '../src/mapping.js';

describe('value sources', () => {
  it('resolves deterministic JSON paths and distinguishes missing from null', () => {
    const value = { 'a.b': [{ value: null }] };
    expect(resolveJsonPath(value, "$['a.b'][0].value")).toEqual({
      kind: 'value',
      value: null,
    });
    expect(resolveJsonPath(value, "$['a.b'][1]")).toEqual({ kind: 'missing' });
    expect(resolveJsonPath(value, '$..value')).toEqual(
      expect.objectContaining({ kind: 'error', code: 'invalid_path' }),
    );
  });
  it('resolves literal, run, node, and structured input through one seam', async () => {
    const context = {
      runInput: { name: 'Ada' },
      nodeOutputs: { prior: { count: 2 } },
      structuredInputs: { item: { name: 'Grace' }, ordinal: 4 },
    };
    expect(
      await resolveValueSource({ kind: 'literal', value: 3 }, context),
    ).toEqual({ kind: 'value', value: 3 });
    expect(
      await resolveValueSource({ kind: 'run_input', path: '$.name' }, context),
    ).toEqual({ kind: 'value', value: 'Ada' });
    expect(
      await resolveValueSource(
        { kind: 'node_output', nodeId: 'prior', path: '$.count' },
        context,
      ),
    ).toEqual({ kind: 'value', value: 2 });
    expect(
      await resolveValueSource(
        { kind: 'node_output', nodeId: 'absent', path: '$' },
        context,
      ),
    ).toEqual({ kind: 'missing' });
    expect(
      await resolveValueSource(
        { kind: 'structured_input', port: 'item', path: '$.name' },
        context,
      ),
    ).toEqual({ kind: 'value', value: 'Grace' });
    expect(
      await resolveValueSource(
        { kind: 'structured_input', port: 'ordinal', path: '$' },
        context,
      ),
    ).toEqual({ kind: 'value', value: 4 });
    expect(
      await resolveValueSource(
        { kind: 'structured_input', port: 'absent', path: '$' },
        context,
      ),
    ).toEqual({ kind: 'missing' });
  });
  it('propagates the execution cancellation signal through expression mapping', async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const evaluator = {
      evaluate: (request: { signal?: AbortSignal }) => {
        received = request.signal;
        return Promise.resolve({
          kind: 'value' as const,
          value: 'ok' as const,
          canonicalBytes: 4,
        });
      },
    } as unknown as JsonataEvaluator;
    await resolveValueSource(
      {
        kind: 'expression',
        language: 'jsonata',
        expression: '"ok"',
        policyVersion: 1,
      },
      { runInput: null, nodeOutputs: {} },
      evaluator,
      controller.signal,
    );
    expect(received).toBe(controller.signal);
  });
});
