import { describe, expect, it } from 'vitest';
import {
  workflowDuplicateRequestSchema,
  workflowDuplicateResponseSchema,
} from '../../src/index.js';
import { workflowAuthoringOpenApiDocument } from '../../src/server.js';

const versionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
describe('workflow duplication contract', () => {
  it('accepts only bounded normalized names and exact discriminated saved selectors', () => {
    expect(
      workflowDuplicateRequestSchema.parse({
        name: '  Copy ',
        source: { kind: 'draft' },
      }),
    ).toEqual({ name: 'Copy', source: { kind: 'draft' } });
    expect(
      workflowDuplicateRequestSchema.parse({
        name: 'Version',
        source: { kind: 'version', versionId },
      }).source,
    ).toEqual({ kind: 'version', versionId });
    for (const value of [
      { name: 'Copy', source: { kind: 'draft' }, graph: {} },
      { name: 'Copy', source: { kind: 'draft', versionId } },
      { name: 'Copy', source: { kind: 'version' } },
      {
        name: 'Copy',
        source: { kind: 'version', versionId, workspaceId: versionId },
      },
      { name: 'x'.repeat(129), source: { kind: 'draft' } },
    ])
      expect(workflowDuplicateRequestSchema.safeParse(value).success).toBe(
        false,
      );
  });
  it('returns only the new identity and advertises conditional If-Match plus required command/session headers', () => {
    expect(
      workflowDuplicateResponseSchema.parse({ workflowId: versionId }),
    ).toEqual({ workflowId: versionId });
    expect(
      workflowDuplicateResponseSchema.safeParse({
        workflowId: versionId,
        graph: {},
      }).success,
    ).toBe(false);
    const route =
      workflowAuthoringOpenApiDocument.paths[
        '/v1/workspaces/{workspaceId}/workflows/{workflowId}/duplicate'
      ].post;
    expect(route.operationId).toBe('duplicateWorkflow');
    expect(
      route.parameters.find((parameter) => parameter.name === 'If-Match'),
    ).toMatchObject({ required: false });
    expect(
      route.parameters.find(
        (parameter) => parameter.name === 'Idempotency-Key',
      ),
    ).toMatchObject({ required: true });
    expect(route.responses['201'].headers).toHaveProperty('Location');
  });
});
