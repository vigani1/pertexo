import { describe, expect, it } from 'vitest';
import {
  fileColumnLimits,
  parseFileColumns,
} from '@/features/workflow-editor/model/inspector/files/columns';
import { startingConfig } from '@/features/workflow-editor/model/graph/starting-config';
const schema = {
  oneOf: [
    { properties: { format: { const: 'json' } } },
    {
      properties: {
        format: { const: 'csv' },
        columns: { maxItems: 64, items: { maxLength: 256 } },
      },
    },
  ],
};
describe('Create file columns', () => {
  it('uses catalog bounds, preserves exact names and order, and leaves empty discovery explicit', () => {
    expect(startingConfig('core.create_file', [])).toEqual({
      format: 'csv',
      delimiter: ',',
      columns: [],
    });
    const limits = fileColumnLimits(schema);
    expect(limits).toEqual({ count: 64, characters: 256 });
    if (limits === undefined) throw new Error('Missing column bounds');
    expect(parseFileColumns('currency\r\n amount ', limits)).toEqual({
      ok: true,
      value: ['currency', ' amount '],
    });
    expect(parseFileColumns('', limits)).toEqual({ ok: true, value: [] });
    expect(parseFileColumns('amount\namount', limits)).toMatchObject({
      ok: false,
    });
    expect(parseFileColumns('amount\n', limits)).toMatchObject({ ok: false });
    expect(parseFileColumns('x'.repeat(257), limits)).toMatchObject({
      ok: false,
    });
    expect(
      parseFileColumns(
        Array.from({ length: 65 }, (_, i) => String(i)).join('\n'),
        limits,
      ),
    ).toMatchObject({ ok: false });
    expect(fileColumnLimits({})).toBeUndefined();
  });
});
