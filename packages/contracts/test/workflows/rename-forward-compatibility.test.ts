import { expect, it } from 'vitest';
import { workflowRenameResponseSchema } from '../../src/schemas/workflows/authoring.js';
import { workflowProjection } from '../support/workflow-projections.js';

it('decodes a rename response after the server adds response metadata', () => {
  const response = {
    workflow: workflowProjection('Renamed workflow'),
    replayed: false,
  };
  expect(workflowRenameResponseSchema.parse(response)).toEqual(response);
  expect(
    workflowRenameResponseSchema.parse({
      ...response,
      futureMetadata: { reviewed: true },
    }),
  ).toEqual(response);
});
