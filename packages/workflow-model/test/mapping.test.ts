import { describe, expect, it } from 'vitest';
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
  it('resolves literal, run input, node output, and expression through one seam', async () => {
    const context = {
      runInput: { name: 'Ada' },
      nodeOutputs: { prior: { count: 2 } },
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
  });
});
