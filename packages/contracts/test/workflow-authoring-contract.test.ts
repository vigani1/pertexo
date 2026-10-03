import { describe, expect, it } from 'vitest';

import {
  strongEtagSchema,
  workflowCompatibilityReportSchema,
  workflowCreateRequestSchema,
  workflowDraftSaveRequestSchema,
  workflowDraftResponseSchema,
  workflowVersionResponseSchema,
  workflowGraphSchema,
  workflowListQuerySchema,
  workflowRevisionConflictProblemSchema,
  workflowVersionsQuerySchema,
  workflowValidationIssueSchema,
  workflowCallPinSchemaV1,
} from '../src/http/workflow-authoring.js';
import {
  workflowAuthoringClientContract,
  workflowAuthoringOpenApiDocument,
} from '../src/workflow-authoring.js';

describe('workflow-authoring public contracts', () => {
  it('exposes exact native Call pin admission through the browser authoring facade', () => {
    const pin = {
      workflowId: '11111111-1111-4111-8111-111111111111',
      versionId: '22222222-2222-4222-8222-222222222222',
      checksum: `wf:v3:sha256:${'a'.repeat(64)}`,
      callableContractIdentity: `callable:v1:sha256:${'b'.repeat(64)}`,
    };
    expect(workflowCallPinSchemaV1.parse(pin)).toEqual(pin);
    expect(
      workflowCallPinSchemaV1.safeParse({ ...pin, versionId: 'latest' })
        .success,
    ).toBe(false);
    expect(
      workflowCallPinSchemaV1.safeParse({
        ...pin,
        checksum: `wf:v2:sha256:${'a'.repeat(64)}`,
      }).success,
    ).toBe(false);
  });
  it('transports native graphs only under coherent explicit draft/version formats', () => {
    const graph = {
      schemaVersion: 2,
      nodes: [],
      edges: [],
      settings: {},
      callable: {
        schemaVersion: 1,
        input: { type: 'object', properties: {}, required: [] },
        result: { type: 'object', properties: {}, required: [] },
        resultSelector: { kind: 'literal', value: {} },
      },
    };
    expect(workflowDraftSaveRequestSchema.parse({ graph })).toEqual({ graph });
    expect(workflowGraphSchema.safeParse(graph).success).toBe(false);
    const draft = {
      workflowId: '11111111-1111-4111-8111-111111111111',
      revision: 1,
      schemaVersion: 2,
      graph,
      compatibility: {
        compatible: true,
        fingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
        issues: [],
      },
      updatedAt: '2026-10-03T00:00:00.000Z',
    };
    expect(workflowDraftResponseSchema.parse(draft)).toEqual(draft);
    expect(
      workflowDraftResponseSchema.safeParse({ ...draft, schemaVersion: 1 })
        .success,
    ).toBe(false);
    expect(
      workflowDraftResponseSchema.safeParse({
        ...draft,
        graph: { schemaVersion: 1, nodes: [], edges: [], settings: {} },
      }).success,
    ).toBe(false);
    const version = {
      id: draft.workflowId,
      workflowId: draft.workflowId,
      versionNumber: 1,
      schemaVersion: 2,
      graph,
      checksum: `wf:v3:sha256:${'a'.repeat(64)}`,
      publishedAt: draft.updatedAt,
    };
    expect(workflowVersionResponseSchema.parse(version)).toEqual(version);
    for (const checksum of [
      `wf:v1:sha256:${'a'.repeat(64)}`,
      `wf:v2:sha256:${'a'.repeat(64)}`,
    ])
      expect(
        workflowVersionResponseSchema.safeParse({ ...version, checksum })
          .success,
      ).toBe(false);
    expect(
      workflowVersionResponseSchema.safeParse({ ...version, schemaVersion: 1 })
        .success,
    ).toBe(false);
    expect(
      strongEtagSchema.safeParse(`"draft-v2.${'a'.repeat(43)}"`).success,
    ).toBe(true);
    expect(
      strongEtagSchema.safeParse(`"draft-v3.${'a'.repeat(43)}"`).success,
    ).toBe(false);
  });
  it('keeps expression and executable issue codes representable and declares checked snapshot/unavailability metadata', () => {
    for (const code of ['invalid_expression', 'executable_invalid'])
      expect(
        workflowValidationIssueSchema.parse({
          code,
          path: '$.nodes.action.inputMappings.value',
          message: 'The expression cannot be parsed.',
        }).code,
      ).toBe(code);
    const validate =
      workflowAuthoringOpenApiDocument.paths[
        '/v1/workspaces/{workspaceId}/workflows/{workflowId}/validate'
      ].post;
    expect(validate.responses['200'].headers).toMatchObject({
      ETag: { required: true },
    });
    expect(validate.responses['503']).toEqual({
      $ref: '#/components/responses/ValidationUnavailable',
    });
    const publish =
      workflowAuthoringOpenApiDocument.paths[
        '/v1/workspaces/{workspaceId}/workflows/{workflowId}/publish'
      ].post;
    expect(publish.responses['503']).toEqual(validate.responses['503']);
    expect(
      workflowAuthoringOpenApiDocument.components.responses
        .ValidationUnavailable.headers['Retry-After'].schema.const,
    ).toBe(1);
  });
  it('defines strict authoring input and strong ETag preconditions', () => {
    expect(
      workflowListQuerySchema.parse({ limit: '5', order: 'updated_desc' }),
    ).toEqual({ limit: 5, order: 'updated_desc' });
    expect(workflowListQuerySchema.safeParse({ order: 'newest' }).success).toBe(
      false,
    );
    expect(
      workflowVersionsQuerySchema.safeParse({ order: 'updated_desc' }).success,
    ).toBe(false);
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
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/duplicate',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/versions/{versionId}/restore',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/archive',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/restore',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/rename',
      '/v1/workspaces/{workspaceId}/workflows',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/draft',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/validate',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/publish',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/versions',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/auto-pause',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/resume',
      '/v1/workspaces/{workspaceId}/auto-pause',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/concurrency',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/input-cases',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/input-cases/{caseId}',
      '/v1/workspaces/{workspaceId}/workflow-tags',
      '/v1/workspaces/{workspaceId}/workflow-tags/cleanup/detach',
      '/v1/workspaces/{workspaceId}/workflow-tags/{tagId}/rename',
      '/v1/workspaces/{workspaceId}/workflow-tags/{tagId}/delete',
      '/v1/workspaces/{workspaceId}/workflow-tags/{tagId}/workflows',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/tags',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/favorite',
      '/v1/workspaces/{workspaceId}/workflow-folders',
      '/v1/workspaces/{workspaceId}/workflow-folders/{folderId}/rename',
      '/v1/workspaces/{workspaceId}/workflow-folders/{folderId}/move',
      '/v1/workspaces/{workspaceId}/workflow-folders/{folderId}/delete',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/folder',
      '/v1/workspaces/{workspaceId}/workflows/organization/bulk',
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
      paths['/v1/workspaces/{workspaceId}/workflows'].get.parameters.map(
        ({ name }) => name,
      ),
    ).toContain('order');
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
