import {
  NODE_JSON_LIMITS_V1,
  boundedNodeJsonRecordSchema,
} from '@pertexo/node-sdk';
import {
  CALLABLE_VALUE_JSON_LIMITS_V1,
  validateCallableValueV1,
} from '@pertexo/workflow-model';
import { describe, expect, it } from 'vitest';

describe('workflow call independent JSON and callable policies', () => {
  it('retains the SDK fixed node JSON limits at the higher-level integration seam', () => {
    expect(CALLABLE_VALUE_JSON_LIMITS_V1).toEqual(NODE_JSON_LIMITS_V1);
  });

  it('normalizes through the SDK owner before applying the closed callable contract', () => {
    const input = { name: 'Ada' };
    const normalized = boundedNodeJsonRecordSchema.parse(input);
    input.name = 'changed';
    expect(normalized).toEqual({ name: 'Ada' });
    expect(
      validateCallableValueV1(
        {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
        normalized,
      ),
    ).toEqual({ ok: true });
    expect(
      validateCallableValueV1(
        { type: 'object', properties: {}, required: [] },
        normalized,
      ),
    ).toEqual({ ok: false, issue: { code: 'undeclared_property', path: '$' } });
  });
});
