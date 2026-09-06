import { describe, expect, it } from 'vitest';
import {
  workflowAuthoringOpenApiDocument,
  workflowLifecycleConflictProblemSchema,
  workflowLifecycleRequestSchema,
  workflowLifecycleRevisionSchema,
  workflowSummarySchema,
  workflowVersionRestoreRequestSchema,
} from '../src/workflow-authoring.js';

describe('workflow lifecycle public contract', () => {
  it('restores a version with an empty body and draft precondition, without idempotency', () => {
    expect(workflowVersionRestoreRequestSchema.parse({})).toEqual({});
    expect(
      workflowVersionRestoreRequestSchema.safeParse({ publish: true }).success,
    ).toBe(false);
    const operation =
      workflowAuthoringOpenApiDocument.paths[
        '/v1/workspaces/{workspaceId}/workflows/{workflowId}/versions/{versionId}/restore'
      ].post;
    const names = operation.parameters.map(({ name }) => name);
    expect(names).toContain('If-Match');
    expect(names).not.toContain('Idempotency-Key');
    expect(operation.security).toEqual([{ cookieSession: [] }]);
    expect(operation.responses).toHaveProperty('200');
    expect(operation.responses).toHaveProperty('412');
    expect(operation.responses).toHaveProperty('428');
  });
  it('uses one safe revision contract in summaries and commands', () => {
    expect(workflowSummarySchema.shape.lifecycleRevision).toBe(
      workflowLifecycleRevisionSchema,
    );
    expect(workflowLifecycleRequestSchema.shape.expectedLifecycleRevision).toBe(
      workflowLifecycleRevisionSchema,
    );
    expect(
      workflowLifecycleRequestSchema.parse({ expectedLifecycleRevision: 1 }),
    ).toEqual({ expectedLifecycleRevision: 1 });
    expect(
      workflowLifecycleRequestSchema.safeParse({
        expectedLifecycleRevision: 1,
        cancelRuns: true,
      }).success,
    ).toBe(false);
    for (const expectedLifecycleRevision of [
      undefined,
      0,
      -1,
      1.5,
      '1',
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(
        workflowLifecycleRequestSchema.safeParse({ expectedLifecycleRevision })
          .success,
      ).toBe(false);
    }
  });

  it.each(['archive', 'restore'] as const)(
    'documents authenticated %s acceptance without a draft precondition',
    (command) => {
      const path =
        `/v1/workspaces/{workspaceId}/workflows/{workflowId}/${command}` as const;
      const operation = workflowAuthoringOpenApiDocument.paths[path].post;
      expect(operation.operationId).toBe(`${command}Workflow`);
      expect(operation.security).toEqual([{ cookieSession: [] }]);
      expect(operation.parameters.map(({ name }) => name)).toEqual([
        'workspaceId',
        'workflowId',
        'x-csrf-token',
        'Idempotency-Key',
      ]);
      expect(operation.responses).toHaveProperty('202');
      expect(operation.responses).toHaveProperty('409');
      expect(operation.requestBody).toHaveProperty('required', true);
    },
  );

  it('keeps lifecycle conflicts separate from draft ETags', () => {
    const conflict = {
      type: 'urn:pertexo:problem:workflow.lifecycle_conflict',
      title: 'Workflow lifecycle conflict',
      status: 409,
      code: 'workflow.lifecycle_conflict',
      requestId: 'request-42',
      currentLifecycleRevision: 3,
    };
    expect(
      workflowLifecycleConflictProblemSchema.safeParse(conflict).success,
    ).toBe(true);
    expect(
      workflowLifecycleConflictProblemSchema.safeParse({
        ...conflict,
        currentEtag: 'draft',
      }).success,
    ).toBe(false);
  });
});
