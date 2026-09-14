import { describe, expect, it } from 'vitest';

import {
  strongEtagSchema,
  workflowCompatibilityReportSchema,
  workflowCreateRequestSchema,
  workflowDraftSaveRequestSchema,
  workflowGraphSchema,
  workflowRevisionConflictProblemSchema,
} from '../src/http/workflow-authoring.js';
import {
  workflowAuthoringClientContract,
  workflowAuthoringOpenApiDocument,
} from '../src/workflow-authoring.js';

describe('workflow-authoring public contracts', () => {
  it('defines strict authoring input and strong ETag preconditions', () => {
    expect(
      workflowCompatibilityReportSchema.safeParse({
        compatible: true,
        fingerprint:
          'node-compat:v1:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        issues: [],
      }).success,
    ).toBe(true);
    expect(
      workflowCreateRequestSchema.safeParse({
        name: 'Inbound',
        ownerId: 'must-not-be-public-input',
      }).success,
    ).toBe(false);
    expect(strongEtagSchema.safeParse('W/"draft-v1:weak"').success).toBe(false);
    expect(strongEtagSchema.safeParse('"draft-v1.opaque"').success).toBe(false);
    expect(
      strongEtagSchema.safeParse(
        '"draft-v1.AFBYOY0XvOEWP2AEVMsJCblYcXq0biQBej1xbQP46YE"',
      ).success,
    ).toBe(true);
    expect(
      workflowDraftSaveRequestSchema.safeParse({
        graph: {
          schemaVersion: 1,
          nodes: [],
          edges: [],
          settings: {},
          secret: 'must-not-be-public-input',
        },
      }).success,
    ).toBe(false);
    expect(
      workflowGraphSchema.safeParse({
        schemaVersion: 1,
        nodes: [],
        edges: [],
        settings: {},
      }).success,
    ).toBe(true);
  });

  it('documents Phase 2 routes, headers, and revision conflicts', () => {
    const paths = workflowAuthoringOpenApiDocument.paths;
    expect(Object.keys(paths)).toEqual([
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/versions/{versionId}/restore',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/archive',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/restore',
      '/v1/workspaces/{workspaceId}/workflows',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/draft',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/validate',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/publish',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/versions',
    ]);
    expect(
      paths[
        '/v1/workspaces/{workspaceId}/workflows/{workflowId}/draft'
      ].put.parameters.map(({ name }) => name),
    ).toContain('If-Match');
    expect(
      paths[
        '/v1/workspaces/{workspaceId}/workflows/{workflowId}/publish'
      ].post.parameters.map(({ name }) => name),
    ).toEqual(expect.arrayContaining(['If-Match', 'Idempotency-Key']));
    expect(
      paths['/v1/workspaces/{workspaceId}/workflows/{workflowId}/draft'].put
        .responses['428'],
    ).toEqual({ $ref: '#/components/responses/PreconditionRequired' });
    expect(
      workflowAuthoringOpenApiDocument.components.responses.PreconditionFailed
        .headers,
    ).toHaveProperty('ETag.required', true);
    expect(
      paths['/v1/workspaces/{workspaceId}/workflows'].post.responses['201']
        .headers,
    ).toHaveProperty('ETag');
    expect(
      workflowAuthoringClientContract.schemas.WorkflowDraftResponse,
    ).toBeDefined();

    const conflict = {
      type: 'urn:pertexo:problem:workflow.revision_conflict',
      title: 'Draft changed',
      status: 412,
      code: 'workflow.revision_conflict',
      requestId: 'request-42',
      currentRevision: 2,
      currentEtag: '"draft-v1.AFBYOY0XvOEWP2AEVMsJCblYcXq0biQBej1xbQP46YE"',
    };
    expect(workflowRevisionConflictProblemSchema.parse(conflict)).toMatchObject(
      {
        status: 412,
        currentRevision: 2,
      },
    );
    expect(
      workflowRevisionConflictProblemSchema.safeParse({
        ...conflict,
        detail: 'Reload the draft.',
        unexpected: true,
      }).success,
    ).toBe(false);
    for (const operation of [
      paths['/v1/workspaces/{workspaceId}/workflows'].post,
      paths['/v1/workspaces/{workspaceId}/workflows/{workflowId}/draft'].put,
      paths['/v1/workspaces/{workspaceId}/workflows/{workflowId}/validate']
        .post,
      paths['/v1/workspaces/{workspaceId}/workflows/{workflowId}/publish'].post,
    ])
      expect(operation.parameters.map(({ name }) => name)).toContain(
        'x-csrf-token',
      );
  });

  it('rejects hostile recursive graphs without overflowing the stack', () => {
    let graph: Record<string, unknown> = {
      schemaVersion: 1,
      nodes: [],
      edges: [],
      settings: {},
    };
    for (let index = 0; index < 500; index += 1)
      graph = {
        schemaVersion: 1,
        nodes: [
          {
            id: `node-${String(index)}`,
            definition: { key: 'for-each', version: 1 },
            position: { x: 0, y: 0 },
            configVersion: 1,
            config: {},
            inputMappings: {},
            connectionRefs: {},
            structured: {
              kind: 'for_each',
              maxIterations: 1,
              maxConcurrency: 1,
              body: { ...graph, inputPorts: [], outputPorts: [] },
            },
          },
        ],
        edges: [],
        settings: {},
      };
    expect(() => workflowGraphSchema.safeParse(graph)).not.toThrow(RangeError);
    expect(workflowGraphSchema.safeParse(graph).success).toBe(false);
  });
});
