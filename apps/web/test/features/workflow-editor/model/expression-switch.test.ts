import { describe, expect, it } from 'vitest';
import { changeInputMappingKind } from '@/features/workflow-editor/model/inspector/input-mappings/draft';

const base = { id: 'r', destinationKey: 'total' } as const;

// product-ux-28: switching a source to Expression never loses work.
describe('switching an input to Expression', () => {
  it('starts from an expression that reads the source it replaces', () => {
    const row = changeInputMappingKind(
      { ...base, kind: 'node_output', nodeId: 'lookup', path: '$.amount' },
      'expression',
    );
    expect(row).toMatchObject({ kind: 'expression' });
    expect(row.kind === 'expression' ? row.expression : '').toMatch(
      /nodeOutputs\."lookup"\."amount"/u,
    );
  });

  it('brings back what was typed in the expression before', () => {
    expect(
      changeInputMappingKind(
        { ...base, kind: 'literal', literalJson: '1' },
        'expression',
        '',
        '$sum(runInput.items.price)',
      ),
    ).toEqual({
      ...base,
      kind: 'expression',
      expression: '$sum(runInput.items.price)',
    });
  });

  it('starts empty from a typed value, which has nothing to read', () => {
    expect(
      changeInputMappingKind(
        { ...base, kind: 'literal', literalJson: '1' },
        'expression',
      ),
    ).toEqual({ ...base, kind: 'expression', expression: '' });
  });
});
