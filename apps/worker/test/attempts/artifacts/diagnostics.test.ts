import { describe, expect, it } from 'vitest';
import { fileInputDiagnosticSchema } from '@pertexo/node-sdk';
import { FileInputFailure } from '@pertexo/node-sdk/server';
import { describeFileInputFailure } from '../../../src/attempts/artifacts/diagnostics.js';

describe('file diagnostics disclose only fixed reasons and bounded coordinates', () => {
  it('refuses raw content, arbitrary reasons, non-finite and oversized locations', () => {
    for (const value of [
      { reason: 'json_syntax', text: 'secret' },
      { reason: 'arbitrary provider error' },
      { reason: 'csv_columns', record: Infinity, expected: 1, actual: 2 },
      { reason: 'csv_syntax', line: 1048578 },
    ])
      expect(fileInputDiagnosticSchema.safeParse(value).success).toBe(false);
  });
  it('persists actionable content-free locations', () => {
    const error = new FileInputFailure({
      reason: 'csv_columns',
      record: 3,
      expected: 2,
      actual: 1,
    });
    expect(describeFileInputFailure(error.diagnostic)).toContain(
      'record 3 has 1 column; the header has 2',
    );
    expect(
      describeFileInputFailure({ reason: 'json_syntax', position: 42 }),
    ).toContain('position 42');
    for (const reason of ['file_size', 'value_size', 'item_count'] as const)
      expect(describeFileInputFailure({ reason })).toContain('Split the file');
  });
});
