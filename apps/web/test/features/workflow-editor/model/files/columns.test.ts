import { describe, expect, it } from 'vitest';
import {
  addFileColumns,
  fileColumnLimits,
  moveFileColumn,
} from '@/features/workflow-editor/model/inspector/files/columns';

const schema = {
  oneOf: [
    { properties: { format: { const: 'json' } } },
    {
      properties: {
        columns: { maxItems: 3, items: { type: 'string', maxLength: 8 } },
      },
    },
  ],
};

describe('file columns', () => {
  it('reads the column limits from the step schema', () => {
    expect(fileColumnLimits(schema)).toEqual({ count: 3, characters: 8 });
    expect(fileColumnLimits({})).toBeUndefined();
  });

  it('adds a name, or each line of pasted names, keeping their spelling', () => {
    const limits = { count: 3, characters: 8 };
    expect(addFileColumns([], ' amount', limits)).toEqual({
      ok: true,
      value: [' amount'],
    });
    expect(addFileColumns(['id'], 'currency\r\namount\n', limits)).toEqual({
      ok: true,
      value: ['id', 'currency', 'amount'],
    });
  });

  it.each([
    [[], '', 'Type a field name'],
    [['id'], 'id', 'each column once'],
    [['a', 'b'], 'c\nd', 'up to 3 columns'],
    [[], '   ', 'nonblank names'],
    [[], 'x'.repeat(9), 'up to 8 characters'],
  ])('refuses %j + %j', (columns, text, error) => {
    const result = addFileColumns(columns, text, { count: 3, characters: 8 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(error);
  });

  it('moves a column one place and stays put at the ends', () => {
    expect(moveFileColumn(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveFileColumn(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveFileColumn(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moveFileColumn(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });
});
