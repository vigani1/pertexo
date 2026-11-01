import { describe, expect, it } from 'vitest';
import { STORED_EXECUTION_VALUE_LIMITS } from '@pertexo/node-sdk';
import { retainCodeOutput } from '../../../src/attempts/code/output.js';
const succeeded = (output: string) => ({
  kind: 'succeeded' as const,
  output,
  diagnostics: { logs: [], truncated: false },
});
describe('retained Code output', () => {
  it('accepts the exact existing inline value boundary', () => {
    const result = succeeded(
      'x'.repeat(STORED_EXECUTION_VALUE_LIMITS.inlineBytes - 2),
    );
    expect(retainCodeOutput(result)).toBe(result);
  });
  it.each([
    'x'.repeat(STORED_EXECUTION_VALUE_LIMITS.inlineBytes),
    '\0',
    '\ud800',
  ])(
    'reports an invalid retained value as a private Code diagnostic',
    (value) => {
      expect(retainCodeOutput(succeeded(value))).toMatchObject({
        kind: 'failed',
        code: 'code.output_invalid',
      });
    },
  );
});
