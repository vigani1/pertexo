import { expect, it } from 'vitest';
import { operationSetupFields } from '@/features/workflow-editor/model/inspector/transforms/operation-fields';
import { utilityOperationConfig } from '@/features/workflow-editor/model/inspector/transforms/utility-config';
import { startingConfig } from '@/features/workflow-editor/model/graph/starting-config';
it('keeps materialized utility choices and operation fields aligned without dropping unknown schema fields', () => {
  for (const key of [
    'core.text',
    'core.xml',
    'core.html',
    'core.crypto',
    'core.number',
    'core.hmac',
  ])
    expect(startingConfig(key, [])).toEqual(utilityOperationConfig(key));
  const schema = {
    oneOf: [
      {
        type: 'object',
        properties: { operation: { const: 'uuid' } },
        required: ['operation'],
      },
      {
        type: 'object',
        properties: {
          operation: { const: 'random_id' },
          length: { type: 'integer', minimum: 1, maximum: 256 },
          futureOption: { type: 'boolean' },
        },
        required: ['operation', 'length'],
      },
    ],
  };
  expect(operationSetupFields(schema, 'uuid', 'core.crypto')?.fields).toEqual(
    [],
  );
  const fields = operationSetupFields(schema, 'random_id', 'core.crypto');
  expect(fields?.fields.map((f) => f.key)).toEqual(['length', 'futureOption']);
  expect(fields?.fields[0]).toMatchObject({
    minimum: 1,
    maximum: 256,
    required: true,
  });
  expect(fields?.operation.optionLabels?.random_id).toBe('Random ID');
  expect(utilityOperationConfig('core.text', 'replace')).toEqual({
    operation: 'replace',
    all: true,
  });
  expect(utilityOperationConfig('core.text', 'unknown')).toBeUndefined();
  expect(operationSetupFields({}, 'unknown', 'core.text')).toBeUndefined();
});
