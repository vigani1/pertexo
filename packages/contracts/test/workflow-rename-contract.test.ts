import { describe, expect, it } from 'vitest';
import {
  workflowAuthoringClientContract,
  workflowAuthoringOpenApiDocument,
  workflowLifecycleRevisionSchema,
  workflowNameConflictProblemSchema,
  workflowNameRevisionSchema,
  workflowRenameRequestSchema,
  workflowRenameResponseSchema,
  workflowSummarySchema,
} from '../src/workflow-authoring.js';

const summary = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  name: 'Invoice sync',
  nameRevision: 2,
  lifecycleStatus: 'active',
  lifecycleRevision: 1,
  activationStatus: 'inactive',
  publishedVersionId: null,
  createdAt: '2026-09-25T08:00:00.000Z',
  updatedAt: '2026-09-25T08:05:00.000Z',
} as const;

describe('workflow rename public contract', () => {
  it('exposes a name revision in every summary, separate from lifecycle', () => {
    expect(workflowSummarySchema.shape.nameRevision).toBe(
      workflowNameRevisionSchema,
    );
    expect(workflowNameRevisionSchema).not.toBe(
      workflowLifecycleRevisionSchema,
    );
    expect(workflowSummarySchema.parse(summary)).toEqual(summary);
    expect(
      workflowSummarySchema.safeParse({ ...summary, nameRevision: undefined })
        .success,
    ).toBe(false);
  });

  it('accepts only a trimmed name with a safe expected name revision', () => {
    expect(
      workflowRenameRequestSchema.parse({
        name: '  Invoice sync  ',
        expectedNameRevision: 1,
      }),
    ).toEqual({ name: 'Invoice sync', expectedNameRevision: 1 });
    for (const name of ['', '   ', 'x'.repeat(129), 42]) {
      expect(
        workflowRenameRequestSchema.safeParse({
          name,
          expectedNameRevision: 1,
        }).success,
      ).toBe(false);
    }
    for (const expectedNameRevision of [
      undefined,
      0,
      -1,
      1.5,
      '1',
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(
        workflowRenameRequestSchema.safeParse({
          name: 'Invoice sync',
          expectedNameRevision,
        }).success,
      ).toBe(false);
    }
    expect(
      workflowRenameRequestSchema.safeParse({
        name: 'Invoice sync',
        expectedNameRevision: 1,
        expectedLifecycleRevision: 1,
      }).success,
    ).toBe(false);
  });

  it('answers with the accepted summary and whether it was replayed', () => {
    expect(
      workflowRenameResponseSchema.parse({ workflow: summary, replayed: true }),
    ).toEqual({ workflow: summary, replayed: true });
    expect(
      workflowRenameResponseSchema.safeParse({
        workflow: summary,
        replayed: false,
        changed: true,
      }).success,
    ).toBe(false);
  });

  it('documents an authenticated, idempotent command with a typed conflict', () => {
    const operation =
      workflowAuthoringOpenApiDocument.paths[
        '/v1/workspaces/{workspaceId}/workflows/{workflowId}/rename'
      ].post;
    expect(operation.operationId).toBe('renameWorkflow');
    expect(operation.security).toEqual([{ cookieSession: [] }]);
    expect(operation.parameters.map(({ name }) => name)).toEqual([
      'workspaceId',
      'workflowId',
      'x-csrf-token',
      'Idempotency-Key',
    ]);
    expect(operation.requestBody).toHaveProperty('required', true);
    expect(Object.keys(operation.responses)).toEqual([
      '200',
      '400',
      '401',
      '403',
      '404',
      '409',
      '500',
    ]);
    expect(JSON.stringify(operation.responses['409'])).toContain(
      '#/components/schemas/WorkflowNameConflictProblem',
    );
    expect(workflowAuthoringClientContract.schemas).toHaveProperty(
      'WorkflowRenameRequest',
    );
  });

  it('carries only the current name revision in a name conflict', () => {
    const conflict = {
      type: 'urn:pertexo:problem:workflow.name_conflict',
      title: 'Workflow name conflict',
      status: 409,
      code: 'workflow.name_conflict',
      requestId: 'request-41',
      currentNameRevision: 3,
    };
    expect(workflowNameConflictProblemSchema.parse(conflict)).toEqual(conflict);
    for (const extension of [
      { currentLifecycleRevision: 3 },
      { currentName: 'Someone else’s name' },
    ])
      expect(
        workflowNameConflictProblemSchema.safeParse({
          ...conflict,
          ...extension,
        }).success,
      ).toBe(false);
  });
});
