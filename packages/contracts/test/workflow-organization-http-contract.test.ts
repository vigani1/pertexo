import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  API_PROBLEM_MANIFEST,
  apiProblemSchema,
} from '../src/errors/api-problem.js';
import { WORKFLOW_ORGANIZATION_PROBLEM_CODES } from '../src/errors/workflow-organization-problems.js';
import { workflowOrganizationContractPaths } from '../src/openapi/workflow-organization-paths.js';
import {
  workflowAuthoringClientContract,
  workflowAuthoringOpenApiDocument,
} from '../src/server.js';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workflow = {
  id,
  workspaceId: id,
  name: 'Visible workflow',
  nameRevision: 1,
  lifecycleStatus: 'active',
  lifecycleRevision: 1,
  activationStatus: 'inactive',
  publishedVersionId: null,
  createdAt: '2026-10-02T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};
const organization = {
  tags: [],
  organizationRevision: 1,
  folderId: null,
  isFavorite: false,
};
type OperationShape = Readonly<{
  security: unknown;
  parameters: readonly Readonly<{
    in: string;
    name: string;
    required: boolean;
  }>[];
  responses: Readonly<Record<string, unknown>>;
}>;

describe('organization HTTP manifest and generated structural contracts', () => {
  it('preserves the original eight tag/favorite operations without executable or graph endpoints', () => {
    const operations = Object.entries(
      workflowOrganizationContractPaths,
    ).flatMap(([path, methods]) =>
      Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
    );
    expect(
      operations.filter(
        (operation) =>
          !operation.includes('workflow-folders') &&
          !operation.endsWith('/folder') &&
          !operation.endsWith('/organization/bulk'),
      ),
    ).toEqual([
      'GET /v1/workspaces/{workspaceId}/workflow-tags',
      'POST /v1/workspaces/{workspaceId}/workflow-tags',
      'POST /v1/workspaces/{workspaceId}/workflow-tags/cleanup/detach',
      'POST /v1/workspaces/{workspaceId}/workflow-tags/{tagId}/rename',
      'POST /v1/workspaces/{workspaceId}/workflow-tags/{tagId}/delete',
      'GET /v1/workspaces/{workspaceId}/workflow-tags/{tagId}/workflows',
      'POST /v1/workspaces/{workspaceId}/workflows/{workflowId}/tags',
      'PUT /v1/workspaces/{workspaceId}/workflows/{workflowId}/favorite',
    ]);
  });

  it('requires authenticated CSRF and idempotency command headers and private no-store responses', () => {
    for (const methods of Object.values(workflowOrganizationContractPaths)) {
      for (const [method, operation] of Object.entries(methods) as [
        string,
        OperationShape,
      ][]) {
        expect(operation.security).toEqual([{ cookieSession: [] }]);
        const headers = operation.parameters.filter(
          (parameter) => parameter.in === 'header',
        );
        // Setting a favorite is idempotent by itself and needs no key.
        expect(headers.map((parameter) => parameter.name)).toEqual(
          method === 'post'
            ? ['x-csrf-token', 'Idempotency-Key']
            : method === 'put'
              ? ['x-csrf-token']
              : [],
        );
        expect(headers.every((header) => header.required)).toBe(true);
        const success =
          '201' in operation.responses
            ? operation.responses['201']
            : operation.responses['200'];
        expect(success).toHaveProperty(
          'headers.Cache-Control.schema.const',
          'private, no-store',
        );
        expect(success).toHaveProperty('headers.Cache-Control.required', true);
        expect(operation.responses).toHaveProperty('503');
        expect(operation.responses).toHaveProperty('429');
        if (method !== 'get')
          expect(operation).toHaveProperty('requestBody.required', true);
      }
    }
  });

  it('documents active reader/favorite and narrow owner/admin vocabulary/discovery authority', () => {
    const paths = workflowOrganizationContractPaths;
    expect(
      paths['/v1/workspaces/{workspaceId}/workflow-tags'].get.description,
    ).toContain('workflow:read');
    expect(
      paths['/v1/workspaces/{workspaceId}/workflow-tags'].post.description,
    ).toContain('owner/admin');
    expect(
      paths['/v1/workspaces/{workspaceId}/workflows/{workflowId}/tags'].post
        .description,
    ).toContain('workflow:update');
    const favorite =
      paths['/v1/workspaces/{workspaceId}/workflows/{workflowId}/favorite'].put;
    expect(favorite.description).toContain('including viewers');
    expect(favorite.description).toContain('archived workflows allowed');
    const discovery =
      paths['/v1/workspaces/{workspaceId}/workflow-tags/{tagId}/workflows'].get;
    expect(discovery.description).toContain(
      'Missing/foreign tags return generic not-found',
    );
    expect(discovery.description).toContain('ascending workflow UUID');
    expect(
      discovery.parameters
        .filter((parameter) => parameter.in === 'query')
        .map((parameter) => parameter.name),
    ).toEqual(['limit', 'after']);
    expect(discovery.responses['404']).toEqual({
      $ref: '#/components/responses/NotFound',
    });
    expect(
      paths['/v1/workspaces/{workspaceId}/workflow-tags/{tagId}/delete'].post
        .description,
    ).toContain('workflow.tag_delete_overflow and zero changes');
    expect(
      paths['/v1/workspaces/{workspaceId}/workflow-tags/cleanup/detach'].post
        .description,
    ).toContain('remaining items are not_processed');
  });

  it('adds authoritative filters and disjoint GET include variants while retaining legacy schemas', () => {
    const list =
      workflowAuthoringOpenApiDocument.paths[
        '/v1/workspaces/{workspaceId}/workflows'
      ].get;
    expect(
      list.parameters
        .filter((parameter) => parameter.in === 'query')
        .map((parameter) => parameter.name),
    ).toEqual([
      'limit',
      'after',
      'order',
      'query',
      'view',
      'tagId',
      'folderId',
      'favoritesOnly',
      'include',
    ]);
    expect(
      list.responses['200'].content['application/json'].schema.anyOf,
    ).toEqual([
      { $ref: '#/components/schemas/WorkflowListResponse' },
      { $ref: '#/components/schemas/WorkflowOrganizationListResponse' },
    ]);
    const get =
      workflowAuthoringOpenApiDocument.paths[
        '/v1/workspaces/{workspaceId}/workflows/{workflowId}'
      ].get;
    expect(
      get.parameters.find((parameter) => parameter.name === 'include'),
    ).toMatchObject({
      schema: {
        enum: ['templateOrigin', 'organization', 'templateOrigin,organization'],
      },
    });
    expect(
      get.responses['200'].content['application/json'].schema.oneOf,
    ).toHaveLength(4);
    const defaults = workflowAuthoringClientContract.schemas;
    expect(defaults.WorkflowSummaryResponse).toMatchObject({
      additionalProperties: false,
      required: ['workflow'],
    });
    expect(defaults.WorkflowSummaryResponse).not.toHaveProperty(
      'properties.organization',
    );
    expect(
      defaults.WorkflowTemplateOriginProjectionResponse,
    ).not.toHaveProperty('properties.organization');
    expect(defaults.WorkflowListResponse).toHaveProperty(
      'additionalProperties',
      false,
    );
    expect(defaults.WorkflowListResponse).not.toHaveProperty(
      'properties.total',
    );
  });

  it('accepts empty default/projected pages through anyOf without fabricating metadata or totals', () => {
    const document = workflowAuthoringOpenApiDocument;
    const response =
      document.paths['/v1/workspaces/{workspaceId}/workflows'].get.responses[
        '200'
      ].content['application/json'].schema;
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const validate = ajv.compile({
      ...response,
      components: document.components,
    });
    for (const page of [
      { items: [], nextCursor: null },
      { items: [workflow], nextCursor: null },
      { items: [{ workflow, organization }], nextCursor: null },
    ])
      expect(validate(page), JSON.stringify(validate.errors)).toBe(true);
    for (const invalid of [
      { items: [{ workflow }], nextCursor: null },
      { items: [], nextCursor: null, total: 0 },
      { items: [{ workflow, organization: null }], nextCursor: null },
    ])
      expect(validate(invalid)).toBe(false);
    const getResponse =
      document.paths['/v1/workspaces/{workspaceId}/workflows/{workflowId}'].get
        .responses['200'].content['application/json'].schema;
    const validateGet = ajv.compile({
      ...getResponse,
      components: document.components,
    });
    for (const result of [
      { workflow },
      { workflow, templateOrigin: null },
      { workflow, organization },
      { workflow, organization, templateOrigin: null },
    ])
      expect(validateGet(result), JSON.stringify(validateGet.errors)).toBe(
        true,
      );
  });

  it('centralizes exactly the accepted sanitized problems without private extension fields', () => {
    expect(WORKFLOW_ORGANIZATION_PROBLEM_CODES).toHaveLength(12);
    for (const code of WORKFLOW_ORGANIZATION_PROBLEM_CODES) {
      const entry = API_PROBLEM_MANIFEST[code];
      expect(entry.status).toBe(
        code === 'workflow.organization_unavailable' ? 503 : 409,
      );
      const problem = {
        type: entry.type,
        title: entry.title,
        status: entry.status,
        code,
        requestId: 'request-organization',
      };
      expect(apiProblemSchema.parse(problem)).toEqual(problem);
      for (const privateField of [
        'actorId',
        'generation',
        'proof',
        'favoriteRevision',
        'currentRevision',
      ])
        expect(
          apiProblemSchema.safeParse({ ...problem, [privateField]: id })
            .success,
        ).toBe(false);
    }
    for (const code of [
      'workflow.concurrency_revision_conflict',
      'workflow.concurrency_limit_exceeded',
      'workflow.concurrency_limit_unavailable',
    ] as const)
      expect(API_PROBLEM_MANIFEST[code]).toEqual({
        status: 409,
        title:
          code === 'workflow.concurrency_revision_conflict'
            ? 'Workflow concurrency revision conflict'
            : code === 'workflow.concurrency_limit_exceeded'
              ? 'Workflow concurrency limit exceeded'
              : 'Workflow concurrency limit unavailable',
        severity: 'warn',
        exposeDetail: true,
        type: `urn:pertexo:problem:${code}`,
      });
  });
});
