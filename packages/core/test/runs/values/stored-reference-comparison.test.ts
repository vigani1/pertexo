import { describe, expect, it } from 'vitest';
import { storedExecutionValuesEqual } from '../../../src/runs/values/stored-execution.js';
import { StoredExecutionValueInvalidError } from '@pertexo/node-sdk';
describe('stored execution reference comparison', () => {
  it('keeps absent outputs equal only to another absent output', () => {
    expect(storedExecutionValuesEqual(null, null)).toBe(true);
    expect(
      storedExecutionValuesEqual(null, { kind: 'inline', value: null }),
    ).toBe(false);
    expect(storedExecutionValuesEqual({ kind: 'inline', value: 0 }, null)).toBe(
      false,
    );
  });
  it('compares the exact descriptor and canonical value', () => {
    expect(
      storedExecutionValuesEqual(
        { kind: 'inline', value: { b: 2, a: 1 } },
        { value: { a: 1, b: 2 }, kind: 'inline' },
      ),
    ).toBe(true);
    expect(
      storedExecutionValuesEqual(
        { kind: 'inline', value: 1 },
        { kind: 'inline', value: '1' },
      ),
    ).toBe(false);
    expect(
      storedExecutionValuesEqual(
        {
          kind: 'artifact',
          artifactId: '11111111-1111-4111-8111-111111111111',
        },
        {
          kind: 'artifact',
          artifactId: '22222222-2222-4222-8222-222222222222',
        },
      ),
    ).toBe(false);
  });
  it('accepts the value limit with descriptor overhead while refusing malformed/oversized values', () => {
    const value = {
      batches: Array.from({ length: 4998 }, (_, i) => [i]),
      inputCount: 4998,
      batchCount: 4998,
    };
    expect(
      storedExecutionValuesEqual(
        { kind: 'inline', value },
        { kind: 'inline', value },
      ),
    ).toBe(true);
    expect(() =>
      storedExecutionValuesEqual(
        {
          kind: 'inline',
          value: {
            batches: Array.from({ length: 4999 }, (_, i) => [i]),
            inputCount: 4999,
            batchCount: 4999,
          },
        },
        { kind: 'inline', value },
      ),
    ).toThrow(StoredExecutionValueInvalidError);
    expect(() =>
      storedExecutionValuesEqual(
        { kind: 'unknown', value: 0 },
        { kind: 'inline', value: 0 },
      ),
    ).toThrow(StoredExecutionValueInvalidError);
  });
});
