import { describe, expect, it } from 'vitest';
import { startingConfig } from '@/features/workflow-editor/model/graph/starting-config';
import { describeTransformFields } from '@/features/workflow-editor/model/inspector/transforms/fields';
import { schemaFields } from '@/features/workflow-editor/model/inspector/draft';

describe('transform authoring', () => {
  it('materializes explicit defaults without adding optional grouping', () => {
    expect(startingConfig('core.filter', [])).toEqual({
      path: '$',
      operator: 'equals',
    });
    expect(startingConfig('core.sort', [])).toEqual({
      path: '$',
      valueType: 'number',
      direction: 'ascending',
      missing: 'last',
    });
    expect(startingConfig('core.unique', [])).toEqual({
      path: '$',
      missing: 'error',
    });
    expect(startingConfig('core.summarize', [])).toEqual({
      valuePath: '$',
      missing: 'error',
    });
    expect(startingConfig('core.date', [])).toEqual({ operation: 'to_iso' });
  });
  it('shows words without changing raw choices, unknown choices or schema bounds', () => {
    const fields = schemaFields({
      type: 'object',
      properties: {
        operator: {
          type: 'string',
          enum: ['equals', 'not_equals', 'future_operator'],
        },
        path: { type: 'string', title: 'Item path' },
      },
      required: ['operator', 'path'],
    });
    const shown = describeTransformFields(fields, 'core.filter');
    expect(shown[0]).toMatchObject({
      required: true,
      options: ['equals', 'not_equals', 'future_operator'],
      optionLabels: { not_equals: 'Does not equal' },
    });
    expect(shown[1]).toMatchObject({
      key: 'path',
      label: 'Item path',
      required: true,
    });
    expect(fields[0]).not.toHaveProperty('optionLabels');
    expect(describeTransformFields(fields, 'partner.custom')).toEqual(fields);
  });
});
