import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { CONTRACT_ARTIFACTS } from '../src/artifacts.js';
import {
  connectionsClientContract,
  connectionsOpenApiDocument,
} from '../src/connections.js';
import {
  connectionCreateRequestSchema,
  connectionResponseSchema,
  connectionTestRequestSchema,
  connectionTestResponseSchema,
  httpHeaderCredentialSchema,
  httpHeadersCredentialSchema,
  resendApiKeyCredentialSchema,
} from '../src/http/connections.js';
import {
  API_PROBLEM_CODES,
  API_PROBLEM_MANIFEST,
  apiProblemSchema,
  apiProblemShape,
} from '../src/errors/api-problem.js';
import {
  identityWorkspaceClientContract,
  identityWorkspaceOpenApiDocument,
} from '../src/identity-workspace.js';
import {
  nodeTestExecuteAcceptedResponseSchema,
  nodeTestRequestSchema,
  nodeValidationResponseSchema,
  previewRunResponseSchema,
} from '../src/http/node-testing.js';
import {
  nodeTestingClientContract,
  nodeTestingOpenApiDocument,
} from '../src/node-testing.js';
import {
  idempotencyKeySchema,
  workspaceCreateRequestSchema,
} from '../src/http/identity-workspace.js';
import { manifestProblemResponse } from '../src/openapi-primitives.js';
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
import {
  workflowRunsClientContract,
  workflowRunsOpenApiDocument,
} from '../src/workflow-runs.js';
import {
  workflowRunCancelRequestSchema,
  workflowRunReplayRequestSchema,
  workflowRunStartRequestSchema,
} from '../src/http/workflow-runs.js';

function collectReferences(
  value: unknown,
  references: string[] = [],
): string[] {
  if (value === null || typeof value !== 'object') return references;
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, references);
    return references;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.$ref === 'string') references.push(record.$ref);
  for (const nested of Object.values(record))
    collectReferences(nested, references);
  return references;
}

function resolvesLocalReference(document: unknown, reference: string): boolean {
  if (!reference.startsWith('#/')) return true;
  let current = document;
  for (const encodedPart of reference.slice(2).split('/')) {
    if (current === null || typeof current !== 'object') return false;
    const part = encodedPart.replaceAll('~1', '/').replaceAll('~0', '~');
    current = (current as Record<string, unknown>)[part];
    if (current === undefined) return false;
  }
  return true;
}

describe('public contracts package', () => {
  it('fails closed for mismatched problem metadata', () => {
    expect(() => manifestProblemResponse(500, 'auth.unauthenticated')).toThrow(
      'status does not match',
    );
  });

  it('enforces credential and idempotency boundary refinements', () => {
    expect(httpHeaderCredentialSchema.safeParse({}).success).toBe(false);
    expect(
      httpHeaderCredentialSchema.safeParse({
        Authorization: 'first',
        authorization: 'second',
      }).success,
    ).toBe(false);
    expect(
      httpHeaderCredentialSchema.safeParse({ host: 'provider.test' }).success,
    ).toBe(false);
    expect(
      httpHeaderCredentialSchema.safeParse({
        authorization: `Bearer ${'x'.repeat(16_384)}`,
      }).success,
    ).toBe(false);

    expect(
      resendApiKeyCredentialSchema.parse({
        schemaVersion: 1,
        type: 'resend_api_key',
        apiKey: 're_example_key',
        fromEmail: 'Alerts@Example.COM',
      }).fromEmail,
    ).toBe('Alerts@example.com');
    for (const fromEmail of [
      'bad email@example.com',
      'missing-domain@example',
      'two@@example.com',
      `${'a'.repeat(65)}@example.com`,
      'alerts@-example.com',
    ])
      expect(
        resendApiKeyCredentialSchema.safeParse({
          schemaVersion: 1,
          type: 'resend_api_key',
          apiKey: 're_example_key',
          fromEmail,
        }).success,
      ).toBe(false);

    expect(idempotencyKeySchema.safeParse('one,two').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('one-two').success).toBe(true);
  });

  it('maps every problem code exactly once to stable HTTP metadata', () => {
    expect(Object.keys(API_PROBLEM_MANIFEST)).toEqual(API_PROBLEM_CODES);
    for (const code of API_PROBLEM_CODES) {
      const entry = API_PROBLEM_MANIFEST[code];
      expect(entry.status).toBeGreaterThanOrEqual(400);
      expect(entry.status).toBeLessThan(600);
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.type).toBe(`urn:pertexo:problem:${code}`);
      expect(Object.isFrozen(entry)).toBe(true);
    }
    expect(Object.isFrozen(API_PROBLEM_MANIFEST)).toBe(true);
  });

  it('separates pure validation from acknowledged durable test execution', () => {
    expect(
      nodeTestRequestSchema.parse({
        mode: 'validate',
        expectedRevision: 4,
        sampleInput: { customerId: 'customer-1' },
      }),
    ).toMatchObject({ mode: 'validate', expectedRevision: 4 });
    expect(
      nodeTestRequestSchema.parse({
        mode: 'test_execute',
        expectedRevision: 4,
        input: {
          kind: 'prior_preview',
          previewRunId: '11111111-1111-4111-8111-111111111111',
        },
        acknowledgeSideEffects: true,
      }),
    ).toMatchObject({ mode: 'test_execute' });

    for (const request of [
      {
        mode: 'test_execute',
        expectedRevision: 4,
        input: { kind: 'manual', value: {} },
      },
      {
        mode: 'test_execute',
        expectedRevision: 4,
        input: { kind: 'manual', value: {} },
        acknowledgeSideEffects: false,
      },
      {
        mode: 'validate',
        expectedRevision: 4,
        acknowledgeSideEffects: true,
      },
      {
        mode: 'validate',
        expectedRevision: 4,
        schemaVersion: 2,
      },
    ])
      expect(nodeTestRequestSchema.safeParse(request).success).toBe(false);
  });

  it('bounds validation and secret-free preview status responses', () => {
    const disclosure = {
      sideEffectClass: 'unsafe' as const,
      mayContactProvider: true,
      mayCauseExternalSideEffect: true,
      dryRun: 'not_supported' as const,
    };
    expect(
      nodeValidationResponseSchema.safeParse({
        mode: 'validate',
        valid: true,
        revision: 4,
        nodeId: 'http',
        issues: [],
        disclosure,
      }).success,
    ).toBe(true);

    const preview = {
      id: '11111111-1111-4111-8111-111111111111',
      workspaceId: '22222222-2222-4222-8222-222222222222',
      workflowId: '33333333-3333-4333-8333-333333333333',
      draftRevision: 4,
      nodeId: 'http',
      status: 'queued' as const,
      disclosure,
      output: null,
      safeErrorCode: null,
      createdAt: '2026-08-22T20:00:00.000Z',
      startedAt: null,
      completedAt: null,
      expiresAt: '2026-08-23T20:00:00.000Z',
    };
    expect(
      nodeTestExecuteAcceptedResponseSchema.safeParse({
        mode: 'test_execute',
        preview,
        replayed: false,
      }).success,
    ).toBe(true);
    expect(
      previewRunResponseSchema.safeParse({
        preview: { ...preview, credential: 'must-not-leak' },
      }).success,
    ).toBe(false);
    expect(
      nodeValidationResponseSchema.safeParse({
        mode: 'validate',
        valid: false,
        revision: 4,
        nodeId: 'http',
        issues: Array.from({ length: 101 }, () => ({
          path: '$.config.url',
          code: 'invalid_url',
          message: 'Invalid URL',
        })),
        disclosure,
      }).success,
    ).toBe(false);
  });

  it('documents conditional idempotency and separate preview status reads', () => {
    expect(nodeTestingClientContract.schemaVersion).toBe('1.0.0');
    expect(Object.keys(nodeTestingOpenApiDocument.paths)).toEqual([
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/draft/nodes/{nodeId}/test',
      '/v1/workspaces/{workspaceId}/previews/{previewRunId}',
    ]);
    const operation =
      nodeTestingOpenApiDocument.paths[
        '/v1/workspaces/{workspaceId}/workflows/{workflowId}/draft/nodes/{nodeId}/test'
      ].post;
    expect(operation.parameters.map(({ name }) => name)).toEqual([
      'workspaceId',
      'workflowId',
      'nodeId',
      'x-csrf-token',
      'Idempotency-Key',
    ]);
    expect(operation.parameters.at(-1)).toMatchObject({
      name: 'Idempotency-Key',
      required: false,
    });
    expect(Object.keys(operation.responses)).toEqual([
      '200',
      '202',
      '400',
      '401',
      '403',
      '404',
      '409',
      '422',
      '428',
      '500',
    ]);
  });

  it('defines strict credential input and secret-free connection responses', () => {
    const parsed = connectionCreateRequestSchema.parse({
      providerKey: 'http',
      name: 'Operations API',
      credential: {
        schemaVersion: 1,
        type: 'http_headers',
        headers: { Authorization: 'Bearer opaque', 'X-API-Key': 'key' },
      },
    });
    expect(parsed.providerKey).toBe('http');
    if (parsed.credential.type !== 'http_headers')
      throw new TypeError('HTTP connection credential was not preserved');
    expect(parsed.credential.headers).toEqual({
      authorization: 'Bearer opaque',
      'x-api-key': 'key',
    });
    expect(
      connectionCreateRequestSchema.safeParse({
        ...parsed,
        credential: {
          ...parsed.credential,
          headers: { host: 'metadata.internal' },
        },
      }).success,
    ).toBe(false);
    expect(
      httpHeadersCredentialSchema.safeParse({
        schemaVersion: 1,
        type: 'http_headers',
        headers: { Authorization: 'a', authorization: 'b' },
      }).success,
    ).toBe(false);
    for (const name of ['accept-encoding', 'idempotency-key'])
      expect(
        httpHeadersCredentialSchema.safeParse({
          schemaVersion: 1,
          type: 'http_headers',
          headers: { [name]: 'not-a-credential' },
        }).success,
      ).toBe(false);
    expect(
      connectionResponseSchema.safeParse({
        id: '00000000-0000-4000-8000-000000000001',
        workspaceId: '00000000-0000-4000-8000-000000000002',
        providerKey: 'http',
        name: 'Operations API',
        authType: 'http_headers',
        status: 'active',
        secretVersionId: '00000000-0000-4000-8000-000000000003',
        health: {
          lastTestedAt: null,
          lastHealthyAt: null,
          lastErrorCode: null,
        },
        createdAt: '2026-08-22T18:00:00.000Z',
        updatedAt: '2026-08-22T18:00:00.000Z',
        credential: { authorization: 'must-not-leak' },
      }).success,
    ).toBe(false);
  });

  it('rejects every HTTP field-value control byte unsupported by transport', () => {
    const forbidden = [
      ...Array.from({ length: 32 }, (_, codePoint) => codePoint),
      0x7f,
    ].filter((codePoint) => codePoint !== 0x09);
    for (const codePoint of forbidden) {
      expect(
        httpHeadersCredentialSchema.safeParse({
          schemaVersion: 1,
          type: 'http_headers',
          headers: {
            authorization: `left${String.fromCharCode(codePoint)}right`,
          },
        }).success,
      ).toBe(false);
    }
    expect(
      httpHeadersCredentialSchema.safeParse({
        schemaVersion: 1,
        type: 'http_headers',
        headers: { authorization: 'left\tright' },
      }).success,
    ).toBe(true);
    expect(
      httpHeadersCredentialSchema.parse({
        schemaVersion: 1,
        type: 'http_headers',
        headers: { 'x-latin1': 'é' },
      }).headers,
    ).toEqual({ 'x-latin1': 'é' });
    expect(
      resendApiKeyCredentialSchema.safeParse({
        schemaVersion: 1,
        type: 'resend_api_key',
        apiKey: 're_credential',
        fromEmail: 'invalid:mailbox@example.com',
      }).success,
    ).toBe(false);
  });

  it('documents connection and failure-notification destination operations', () => {
    expect(connectionsClientContract.schemas).toHaveProperty(
      'ConnectionCreateRequest',
    );
    expect(Object.keys(connectionsOpenApiDocument.paths)).toEqual([
      '/v1/workspaces/{workspaceId}/connections',
      '/v1/workspaces/{workspaceId}/connections/{connectionId}/secret',
      '/v1/workspaces/{workspaceId}/connections/{connectionId}',
      '/v1/workspaces/{workspaceId}/connections/{connectionId}/test',
      '/v1/workspaces/{workspaceId}/failure-notification-destinations',
      '/v1/workspaces/{workspaceId}/failure-notification-destinations/{destinationId}',
      '/v1/workspaces/{workspaceId}/failure-notification-destinations/{destinationId}/versions',
      '/v1/workspaces/{workspaceId}/failure-notification-destinations/{destinationId}/status',
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/failure-notification-policy',
    ]);
    expect(
      connectionsOpenApiDocument.paths[
        '/v1/workspaces/{workspaceId}/connections'
      ].post.parameters.map(({ name }) => name),
    ).toEqual(['workspaceId', 'x-csrf-token', 'Idempotency-Key']);
    expect(
      connectionsOpenApiDocument.paths[
        '/v1/workspaces/{workspaceId}/connections/{connectionId}/test'
      ].post.parameters.map(({ name }) => name),
    ).toEqual([
      'workspaceId',
      'connectionId',
      'x-csrf-token',
      'Idempotency-Key',
    ]);
    expect(
      connectionTestRequestSchema.safeParse({
        url: 'https://provider.example.test/health',
      }).success,
    ).toBe(true);
    for (const request of [
      { url: 'http://provider.example.test/health' },
      { url: 'https://user:secret@provider.example.test/health' },
      { url: 'https://provider.example.test/health#secret' },
      { url: 'https://provider.example.test/health', extra: true },
      { url: `https://provider.example.test/${'é'.repeat(1_100)}` },
    ])
      expect(connectionTestRequestSchema.safeParse(request).success).toBe(
        false,
      );
    expect(
      connectionTestResponseSchema.safeParse({
        connection: {
          id: '00000000-0000-4000-8000-000000000001',
          workspaceId: '00000000-0000-4000-8000-000000000002',
          providerKey: 'http',
          name: 'Operations API',
          authType: 'http_headers',
          status: 'active',
          secretVersionId: '00000000-0000-4000-8000-000000000003',
          health: {
            lastTestedAt: '2026-08-22T18:00:00.000Z',
            lastHealthyAt: '2026-08-22T18:00:00.000Z',
            lastErrorCode: null,
          },
          createdAt: '2026-08-22T18:00:00.000Z',
          updatedAt: '2026-08-22T18:00:00.000Z',
        },
        outcome: { ok: true, httpStatus: 204, errorCode: null },
      }).success,
    ).toBe(true);
  });

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

  it('publishes structurally resolvable documents and a real graph schema', () => {
    for (const artifact of CONTRACT_ARTIFACTS) {
      const document = JSON.parse(artifact.content) as unknown;
      for (const reference of collectReferences(document))
        expect(
          resolvesLocalReference(document, reference),
          `${artifact.fileName}: ${reference}`,
        ).toBe(true);
    }
    const saveRequest = workflowAuthoringClientContract.schemas
      .WorkflowDraftSaveRequest as {
      properties?: { graph?: Record<string, unknown> };
    };
    expect(saveRequest.properties?.graph).toMatchObject({
      type: 'object',
      'x-pertexo-runtime-bounds': true,
    });
    expect(saveRequest.properties?.graph?.properties).toMatchObject({
      nodes: { type: 'array', maxItems: 1_000 },
      edges: { type: 'array', maxItems: 4_000 },
      settings: { type: 'object' },
    });
  });

  it('defines strict workflow authoring seams with strong ETag preconditions', () => {
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

  it('defines strict workflow-run contracts without exposing engine state', () => {
    expect(
      workflowRunStartRequestSchema.safeParse({
        input: { customerId: 'customer-42' },
        deadlineAt: '2026-08-21T18:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      workflowRunStartRequestSchema.safeParse({
        input: {},
        initialCheckpoint: { revision: 0 },
      }).success,
    ).toBe(false);
    expect(
      workflowRunCancelRequestSchema.safeParse({ reason: 'operator request' })
        .success,
    ).toBe(true);
    expect(
      workflowRunCancelRequestSchema.safeParse({ reason: 'x'.repeat(501) })
        .success,
    ).toBe(false);
    expect(
      workflowRunReplayRequestSchema.safeParse({
        workflowVersionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        input: null,
      }).success,
    ).toBe(true);
    expect(
      workflowRunReplayRequestSchema.safeParse({
        workflowVersionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      }).success,
    ).toBe(false);

    expect(Object.keys(workflowRunsOpenApiDocument.paths)).toEqual([
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/runs',
      '/v1/workspaces/{workspaceId}/runs/{runId}',
      '/v1/workspaces/{workspaceId}/runs/{runId}/events',
      '/v1/workspaces/{workspaceId}/runs/{runId}/cancel',
      '/v1/workspaces/{workspaceId}/runs/{runId}/replay',
    ]);
    const start =
      workflowRunsOpenApiDocument.paths[
        '/v1/workspaces/{workspaceId}/workflows/{workflowId}/runs'
      ].post;
    expect(start.responses['202']).toBeDefined();
    expect(start.parameters.map((parameter) => parameter.name)).toEqual(
      expect.arrayContaining(['Idempotency-Key', 'x-csrf-token']),
    );
    const stream =
      workflowRunsOpenApiDocument.paths[
        '/v1/workspaces/{workspaceId}/runs/{runId}/events'
      ].get;
    expect(stream.parameters.map((parameter) => parameter.name)).toContain(
      'Last-Event-ID',
    );
    expect(stream.responses['200'].content).toHaveProperty('text/event-stream');
    expect(workflowRunsClientContract.schemas).not.toHaveProperty(
      'WorkflowCheckpoint',
    );
  });
});
