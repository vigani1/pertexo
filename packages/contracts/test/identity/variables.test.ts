import { expect, it } from 'vitest';
import {
  workspaceVariablesRequestSchema,
  workspaceVariablesResponseSchema,
  workflowRunVariablesResponseSchema,
} from '../../src/index.js';
it('keeps omitted metadata distinguishable from explicit clearing and validates its names', () => {
  const body = { expectedRevision: 0, values: { RATE: 0 } };
  expect(workspaceVariablesRequestSchema.parse(body)).toEqual(body);
  expect(
    workspaceVariablesRequestSchema.parse({
      ...body,
      descriptions: { RATE: '  Rate for invoices  ' },
    }).descriptions,
  ).toEqual({ RATE: 'Rate for invoices' });
  expect(
    workspaceVariablesRequestSchema.parse({ ...body, descriptions: {} })
      .descriptions,
  ).toEqual({});
  expect(
    workspaceVariablesRequestSchema.safeParse({
      ...body,
      descriptions: { MISSING: 'No such value' },
    }).success,
  ).toBe(false);
  expect(
    workspaceVariablesResponseSchema.parse({ revision: 0, values: {} }),
  ).toEqual({ revision: 0, values: {}, descriptions: {} });
  expect(
    workflowRunVariablesResponseSchema.parse({
      snapshot: { revision: 0, values: {} },
    }),
  ).toEqual({ snapshot: { revision: 0, values: {} } });
});
it('bounds descriptions independently from execution values', () => {
  const parse = (descriptions: Record<string, string>) =>
    workspaceVariablesRequestSchema.safeParse({
      expectedRevision: 0,
      values: Object.fromEntries(
        Object.keys(descriptions).map((name) => [name, 0]),
      ),
      descriptions,
    });
  expect(parse({ RATE: 'a'.repeat(500) }).success).toBe(true);
  expect(parse({ RATE: 'a'.repeat(501) }).success).toBe(false);
  expect(parse({ RATE: '\0' }).success).toBe(false);
  expect(parse({ lowercase: 'Invalid name' }).success).toBe(false);
  expect(
    parse(
      Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [
          `VALUE_${String(i)}`,
          'a'.repeat(500),
        ]),
      ),
    ).success,
  ).toBe(false);
});
