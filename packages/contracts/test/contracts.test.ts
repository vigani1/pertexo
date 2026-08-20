import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { CONTRACT_ARTIFACTS } from '../src/artifacts.js';
import {
  apiProblemSchema,
  apiProblemShape,
} from '../src/errors/api-problem.js';
import {
  identityWorkspaceClientContract,
  identityWorkspaceOpenApiDocument,
} from '../src/identity-workspace.js';
import { workspaceCreateRequestSchema } from '../src/http/identity-workspace.js';
import {
  strongEtagSchema,
  workflowCreateRequestSchema,
  workflowDraftSaveRequestSchema,
  workflowGraphSchema,
  workflowRevisionConflictProblemSchema,
} from '../src/http/workflow-authoring.js';
import {
  workflowAuthoringClientContract,
  workflowAuthoringOpenApiDocument,
} from '../src/workflow-authoring.js';

describe('public contracts package', () => {
  it('owns strict browser-safe request and RFC 9457 problem schemas', () => {
    expect(Object.keys(apiProblemShape)).toEqual([
      'type',
      'title',
      'status',
      'detail',
      'instance',
      'code',
      'requestId',
      'errors',
    ]);
    expect(
      workspaceCreateRequestSchema.safeParse({
        name: 'Operations',
        slug: 'operations',
        ownerId: 'must-not-be-public-input',
      }).success,
    ).toBe(false);
    expect(
      apiProblemSchema.parse({
        type: 'urn:pertexo:problem:workspace.conflict',
        title: 'Workspace conflict',
        status: 409,
        code: 'workspace.conflict',
        requestId: 'request-42',
      }),
    ).toMatchObject({ status: 409, code: 'workspace.conflict' });
    expect(
      apiProblemSchema.safeParse({
        type: 'urn:pertexo:problem:unknown',
        title: 'Unknown',
        status: 409,
        code: 'unknown.code',
        requestId: 'request-42',
      }).success,
    ).toBe(false);
  });

  it('shares ApiProblem across client schemas and documented error responses', () => {
    expect(identityWorkspaceClientContract.schemas.ApiProblem).toBeDefined();
    for (const response of Object.values(
      identityWorkspaceOpenApiDocument.components.responses,
    )) {
      expect(response.content['application/problem+json'].schema).toEqual({
        $ref: '#/components/schemas/ApiProblem',
      });
    }
    expect(
      identityWorkspaceOpenApiDocument.paths['/v1/workspaces'].post.responses[
        '409'
      ],
    ).toEqual({ $ref: '#/components/responses/Conflict' });
    expect(
      identityWorkspaceOpenApiDocument.paths['/v1/auth/oidc/callback'].get
        .responses['503'],
    ).toEqual({ $ref: '#/components/responses/ServiceUnavailable' });
  });

  it('keeps committed artifacts byte-identical to deterministic generation', async () => {
    for (const artifact of CONTRACT_ARTIFACTS) {
      const committed = await readFile(
        new URL(`../artifacts/${artifact.fileName}`, import.meta.url),
        'utf8',
      );
      expect(committed).toBe(artifact.content);
    }
  });

  it('defines strict workflow authoring seams with strong ETag preconditions', () => {
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

  it('documents all Phase 2 routes, headers, and reusable RFC 9457 problems', () => {
    const paths = workflowAuthoringOpenApiDocument.paths;
    expect(Object.keys(paths)).toEqual([
      '/v1/workspaces/{workspaceId}/workflows',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/draft',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/validate',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/publish',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/versions',
    ]);
    expect(
      paths[
        '/v1/workspaces/{workspaceId}/workflows/{workflowId}/draft'
      ].put.parameters.map((parameter) => parameter.name),
    ).toContain('If-Match');
    expect(
      paths[
        '/v1/workspaces/{workspaceId}/workflows/{workflowId}/publish'
      ].post.parameters.map((parameter) => parameter.name),
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
    expect(
      workflowRevisionConflictProblemSchema.parse({
        type: 'urn:pertexo:problem:workflow.revision_conflict',
        title: 'Draft changed',
        status: 412,
        code: 'workflow.revision_conflict',
        requestId: 'request-42',
        currentRevision: 2,
        currentEtag: '"draft-v1.AFBYOY0XvOEWP2AEVMsJCblYcXq0biQBej1xbQP46YE"',
      }),
    ).toMatchObject({ status: 412, currentRevision: 2 });
    expect(
      workflowRevisionConflictProblemSchema.safeParse({
        type: 'urn:pertexo:problem:workflow.revision_conflict',
        title: 'Draft changed',
        status: 412,
        detail: 'Reload the draft.',
        code: 'workflow.revision_conflict',
        requestId: 'request-42',
        currentRevision: 2,
        currentEtag: '"draft-v1.AFBYOY0XvOEWP2AEVMsJCblYcXq0biQBej1xbQP46YE"',
        unexpected: true,
      }).success,
    ).toBe(false);

    for (const operation of [
      paths['/v1/workspaces/{workspaceId}/workflows'].post,
      paths['/v1/workspaces/{workspaceId}/workflows/{workflowId}/draft'].put,
      paths['/v1/workspaces/{workspaceId}/workflows/{workflowId}/validate']
        .post,
      paths['/v1/workspaces/{workspaceId}/workflows/{workflowId}/publish'].post,
    ]) {
      expect(operation.parameters.map((parameter) => parameter.name)).toContain(
        'x-csrf-token',
      );
    }
  });

  it('rejects hostile recursive graph inputs without overflowing the stack', () => {
    let graph: Record<string, unknown> = {
      schemaVersion: 1,
      nodes: [],
      edges: [],
      settings: {},
    };
    for (let index = 0; index < 500; index += 1) {
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
    }
    expect(() => workflowGraphSchema.safeParse(graph)).not.toThrow(RangeError);
    expect(workflowGraphSchema.safeParse(graph).success).toBe(false);
  });
});
