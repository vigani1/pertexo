import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import * as schemas from '../../../src/schemas/workflows/authoring.js';
import {
  API_PROBLEM_MANIFEST,
  apiProblemSchema,
} from '../../../src/errors/api-problem.js';
import { workflowOrganizationContractPaths } from '../../../src/openapi/workflows/organization.js';
import {
  workflowAuthoringClientContract,
  workflowAuthoringOpenApiDocument,
} from '../../../src/server.js';
import { a, b, items } from '../../support/organization-folders.js';

describe('accepted folder and general-bulk public contracts', () => {
  it('uses exact ordered partial outcomes and stops at authority loss without retained revision leakage', () => {
    const statuses = [
      {
        workflowId: a,
        status: 'updated',
        organizationRevision: 2,
        replayed: true,
      },
      { workflowId: a, status: 'not_visible' },
      { workflowId: a, status: 'outcome_unknown' },
      ...schemas.workflowOrganizationBulkConflictCodeSchema.options.map(
        (code) => ({ workflowId: a, status: 'conflict', code }),
      ),
    ];
    for (const outcome of statuses)
      expect(
        schemas.workflowOrganizationBulkResponseSchema.parse({
          items: [outcome],
        }),
      ).toEqual({ items: [outcome] });
    expect(
      schemas.workflowOrganizationBulkResponseSchema
        .parse({
          items: [
            { workflowId: b, status: 'forbidden' },
            { workflowId: a, status: 'not_processed' },
          ],
        })
        .items.map((item) => item.workflowId),
    ).toEqual([b, a]);
    for (const outcomes of [
      [{ workflowId: a, status: 'not_processed' }],
      [{ workflowId: a, status: 'forbidden', organizationRevision: 1 }],
      [
        { workflowId: a, status: 'forbidden' },
        {
          workflowId: b,
          status: 'updated',
          organizationRevision: 2,
          replayed: false,
        },
      ],
      [
        {
          workflowId: a,
          status: 'conflict',
          code: 'workflow.folder_name_conflict',
        },
      ],
      [statuses[0], statuses[0]],
    ])
      expect(
        schemas.workflowOrganizationBulkResponseSchema.safeParse({
          items: outcomes,
        }).success,
      ).toBe(false);
  });

  it('documents folder operations, sharing and bulk moves with narrow roles and no-store checked commands', () => {
    const paths = workflowOrganizationContractPaths;
    const operations = Object.entries(paths).flatMap(([path, methods]) =>
      Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
    );
    expect(operations.slice(8)).toEqual([
      'GET /v1/workspaces/{workspaceId}/workflow-folders',
      'POST /v1/workspaces/{workspaceId}/workflow-folders',
      'POST /v1/workspaces/{workspaceId}/workflow-folders/{folderId}/rename',
      'POST /v1/workspaces/{workspaceId}/workflow-folders/{folderId}/move',
      'GET /v1/workspaces/{workspaceId}/resource-sharing-principals',
      'GET /v1/workspaces/{workspaceId}/workflow-folders/{folderId}/sharing',
      'POST /v1/workspaces/{workspaceId}/workflow-folders/{folderId}/sharing',
      'POST /v1/workspaces/{workspaceId}/workflow-folders/review-move',
      'POST /v1/workspaces/{workspaceId}/workflow-folders/{folderId}/delete',
      'POST /v1/workspaces/{workspaceId}/workflows/{workflowId}/folder',
      'POST /v1/workspaces/{workspaceId}/workflows/organization/bulk',
    ]);
    expect(
      paths['/v1/workspaces/{workspaceId}/workflow-folders'].post.description,
    ).toContain('without broadening workspace:manage');
    expect(
      paths['/v1/workspaces/{workspaceId}/workflows/{workflowId}/folder'].post
        .description,
    ).toContain('archived placement/unfiling requires owner/admin');
    const bulk =
      paths['/v1/workspaces/{workspaceId}/workflows/organization/bulk'].post;
    expect(bulk.description).toContain('admission is not atomic completion');
    expect(
      bulk.parameters
        .filter((parameter) => parameter.in === 'header')
        .map((parameter) => parameter.name),
    ).toEqual(['x-csrf-token', 'Idempotency-Key']);
    expect(bulk.responses).toHaveProperty(
      '200.headers.Cache-Control.schema.const',
      'private, no-store',
    );
  });

  it('registers only sanitized folder conflict fields and projects strict client/OpenAPI shapes', () => {
    for (const suffix of [
      'name_conflict',
      'limit_exceeded',
      'revision_conflict',
      'hierarchy_conflict',
      'not_empty',
      'not_visible',
    ] as const) {
      const code = `workflow.folder_${suffix}` as const;
      const entry = API_PROBLEM_MANIFEST[code];
      expect(entry.status).toBe(409);
      const problem = {
        type: entry.type,
        title: entry.title,
        status: entry.status,
        code,
        requestId: 'folders-test',
      };
      expect(apiProblemSchema.parse(problem)).toEqual(problem);
      expect(
        apiProblemSchema.safeParse({ ...problem, currentRevision: 1 }).success,
      ).toBe(false);
    }
    const document = workflowAuthoringOpenApiDocument;
    const client = workflowAuthoringClientContract.schemas;
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    for (const [name, valid, invalid] of [
      [
        'WorkflowFolderCreateRequest',
        { name: 'Ops', parentId: null },
        { name: 'Ops', parentId: null, nameKey: 'ops' },
      ],
      [
        'WorkflowOrganizationBulkRequest',
        { operation: 'move', folderId: null, items },
        { operation: 'move', folderId: null, items, tagIds: [] },
      ],
      [
        'WorkflowOrganizationBulkResponse',
        { items: [{ workflowId: a, status: 'not_visible' }] },
        {
          items: [
            { workflowId: a, status: 'not_visible', organizationRevision: 1 },
          ],
        },
      ],
    ] as const) {
      if (name === 'WorkflowOrganizationBulkRequest') {
        expect(client[name]).toMatchObject({
          oneOf: [
            { additionalProperties: false },
            { additionalProperties: false },
          ],
        });
      } else expect(client[name]).toHaveProperty('additionalProperties', false);
      for (const projection of [
        {
          $ref: `#/components/schemas/${name}`,
          components: document.components,
        },
        { $ref: `#/schemas/${name}`, schemas: client },
      ]) {
        const validate = ajv.compile(projection);
        expect(validate(valid), JSON.stringify(validate.errors)).toBe(true);
        expect(validate(invalid)).toBe(false);
      }
    }
  });
});
