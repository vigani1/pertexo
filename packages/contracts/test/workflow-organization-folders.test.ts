import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import * as schemas from '../src/http/workflow-authoring.js';
import {
  API_PROBLEM_MANIFEST,
  apiProblemSchema,
} from '../src/errors/api-problem.js';
import { workflowOrganizationContractPaths } from '../src/workflow-organization-contract.js';
import {
  workflowAuthoringClientContract,
  workflowAuthoringOpenApiDocument,
} from '../src/workflow-authoring.js';

const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const idAt = (index: number) =>
  `${index.toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const folder = { id: a, name: 'Ops', parentId: null, revision: 1, depth: 1 };
const items = [
  { workflowId: b, expectedOrganizationRevision: 2 },
  { workflowId: a, expectedOrganizationRevision: 1 },
];

describe('accepted folder and general-bulk public contracts', () => {
  it('pins hierarchy and explicit selection bounds', () => {
    expect(schemas.WORKFLOW_FOLDER_LIMITS).toEqual({
      nameBytes: 128,
      depth: 4,
      foldersPerWorkspace: 256,
      bulkItems: 50,
    });
    expect(Object.isFrozen(schemas.WORKFLOW_FOLDER_LIMITS)).toBe(true);
  });

  it('trims only U+0020, retains Unicode/display case and enforces UTF-8 name bytes', () => {
    for (const name of [
      'Ops',
      'Équipe',
      'équipe',
      '\u00a0Ops\u00a0',
      'a'.repeat(128),
      'é'.repeat(64),
    ]) {
      expect(schemas.workflowFolderNameInputSchema.parse(`  ${name}  `)).toBe(
        name,
      );
    }
    for (const name of [
      '',
      '  ',
      'é'.repeat(65),
      'a'.repeat(129),
      '\tOps',
      'Ops\n',
      'Ops\r',
      'Ops\0',
      'Ops\u007f',
    ])
      expect(
        schemas.workflowFolderNameInputSchema.safeParse(name).success,
        name,
      ).toBe(false);
    expect(schemas.workflowFolderNameSchema.safeParse(' Ops ').success).toBe(
      false,
    );
    expect(
      schemas.workflowFolderCreateRequestSchema.parse({
        name: '  Ops  ',
        parentId: b.toUpperCase(),
      }),
    ).toEqual({ name: 'Ops', parentId: b });
  });

  it('requires exact bounded folder payloads and safe revisions without internal sibling fields', () => {
    const commands = [
      [
        schemas.workflowFolderCreateRequestSchema,
        { name: 'Ops', parentId: null },
      ],
      [
        schemas.workflowFolderRenameRequestSchema,
        { name: 'Ops', expectedFolderRevision: 1 },
      ],
      [
        schemas.workflowFolderMoveRequestSchema,
        { parentId: null, expectedFolderRevision: 1 },
      ],
      [
        schemas.workflowFolderDeleteRequestSchema,
        { expectedFolderRevision: 1 },
      ],
      [
        schemas.workflowFolderPlacementRequestSchema,
        { folderId: null, expectedOrganizationRevision: 1 },
      ],
    ] as const;
    for (const [schema, body] of commands) {
      expect(schema.safeParse(body).success).toBe(true);
      for (const field of [
        'nameKey',
        'actorId',
        'parentHash',
        'admitted',
        'proof',
      ])
        expect(schema.safeParse({ ...body, [field]: a }).success).toBe(false);
      for (const field of Object.keys(body)) {
        const missing = { ...body };
        Reflect.deleteProperty(missing, field);
        expect(schema.safeParse(missing).success).toBe(false);
      }
    }
    for (const revision of [0, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1])
      expect(
        schemas.workflowFolderDeleteRequestSchema.safeParse({
          expectedFolderRevision: revision,
        }).success,
      ).toBe(false);
    expect(
      schemas.workflowFolderDeleteRequestSchema.parse({
        expectedFolderRevision: Number.MAX_SAFE_INTEGER,
      }),
    ).toEqual({ expectedFolderRevision: Number.MAX_SAFE_INTEGER });
  });

  it('bounds ascending hierarchy inventory, root depth and exact command responses', () => {
    for (const valid of [[], [folder]])
      expect(
        schemas.workflowFolderListResponseSchema.parse({ items: valid }).items,
      ).toEqual(valid);
    expect(
      schemas.workflowFolderListResponseSchema.parse({
        items: [folder, { ...folder, id: b, parentId: a, depth: 4 }],
      }).items,
    ).toHaveLength(2);
    for (const value of [
      { items: new Array<unknown>(1) },
      { items: [undefined, folder] },
      { items: [{ ...folder, id: '' }] },
      { items: [{ ...folder, depth: 5 }] },
      { items: [{ ...folder, depth: 2 }] },
      { items: [{ ...folder, parentId: b, depth: 1 }] },
      { items: [folder, folder] },
      { items: [{ ...folder, id: b }, folder] },
      {
        items: Array.from({ length: 257 }, (_, index) => ({
          ...folder,
          id: idAt(index),
        })),
      },
      { items: [], total: 0 },
      { items: [], nextCursor: null },
    ])
      expect(
        schemas.workflowFolderListResponseSchema.safeParse(value).success,
      ).toBe(false);
    expect(
      schemas.workflowFolderListResponseSchema.parse({
        items: Array.from({ length: 256 }, (_, index) => ({
          ...folder,
          id: idAt(index),
        })),
      }).items,
    ).toHaveLength(256);
    expect(
      schemas.workflowFolderCreateResponseSchema.parse({
        folder,
        replayed: false,
      }),
    ).toEqual({ folder, replayed: false });
    expect(
      schemas.workflowFolderDeleteResponseSchema.safeParse({
        folderId: a,
        deleted: true,
        replayed: true,
        detachedWorkflowCount: 0,
      }).success,
    ).toBe(false);
    expect(
      schemas.workflowFolderPlacementResponseSchema.parse({
        workflowId: a,
        folderId: null,
        organizationRevision: 2,
        replayed: true,
      }).folderId,
    ).toBeNull();
  });

  it('adds exact folder filters and nullable metadata without changing default list grammar', () => {
    for (const folderId of [a.toUpperCase(), 'root'])
      expect(
        schemas.workflowOrganizationListQuerySchema.parse({ folderId }),
      ).toEqual({ folderId: folderId.toLowerCase() });
    for (const folderId of [null, 'ROOT', '', 'all', ' root '])
      expect(
        schemas.workflowOrganizationListQuerySchema.safeParse({ folderId })
          .success,
      ).toBe(false);
    expect(
      schemas.workflowListQuerySchema.safeParse({ folderId: a }).success,
    ).toBe(false);
    const metadata = {
      tags: [],
      folderId: a,
      organizationRevision: 1,
      isFavorite: false,
      favoriteRevision: b,
    };
    expect(schemas.workflowOrganizationSchema.parse(metadata)).toEqual(
      metadata,
    );
    expect(
      schemas.workflowFolderListQuerySchema.safeParse({ limit: '256' }).success,
    ).toBe(false);
  });

  it('accepts only one bounded operation, canonicalizes tag IDs, preserves item order and rejects duplicates', () => {
    const request = {
      operation: 'replace_tags',
      tagIds: [b.toUpperCase(), a],
      items: items.map((item) => ({
        ...item,
        workflowId: item.workflowId.toUpperCase(),
      })),
    };
    expect(
      schemas.workflowOrganizationBulkRequestSchema.parse(request),
    ).toEqual({ operation: 'replace_tags', tagIds: [a, b], items });
    expect(request.tagIds).toEqual([b.toUpperCase(), a]);
    for (const value of [
      { operation: 'move', folderId: null, items: [] },
      { operation: 'move', folderId: null, items: [items[0], items[0]] },
      {
        operation: 'move',
        folderId: null,
        items: [{ workflowId: a, expectedOrganizationRevision: 0 }],
      },
      { operation: 'move', folderId: null, items, tagIds: [] },
      { operation: 'replace_tags', tagIds: [], items, folderId: null },
      { operation: 'replace_tags', tagIds: [a, a.toUpperCase()], items },
      {
        operation: 'replace_tags',
        tagIds: Array.from({ length: 17 }, (_, index) => idAt(index)),
        items,
      },
      { operation: 'delete', items },
      { operation: 'move', items },
      { operation: 'move', folderId: null, items, proof: true },
      {
        operation: 'move',
        folderId: null,
        items: [{ ...items[0], actorId: a }],
      },
    ])
      expect(
        schemas.workflowOrganizationBulkRequestSchema.safeParse(value).success,
      ).toBe(false);
    for (const count of [50, 51])
      expect(
        schemas.workflowOrganizationBulkRequestSchema.safeParse({
          operation: 'move',
          folderId: null,
          items: Array.from({ length: count }, (_, index) => ({
            workflowId: idAt(index),
            expectedOrganizationRevision: 1,
          })),
        }).success,
      ).toBe(count === 50);
  });

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
      {
        workflowId: a,
        status: 'unavailable',
        code: 'workflow.organization_unavailable',
      },
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

  it('adds exactly six folder operations plus bulk with narrow roles and no-store checked commands', () => {
    const paths = workflowOrganizationContractPaths;
    const operations = Object.entries(paths).flatMap(([path, methods]) =>
      Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
    );
    expect(operations.slice(-7)).toEqual([
      'GET /v1/workspaces/{workspaceId}/workflow-folders',
      'POST /v1/workspaces/{workspaceId}/workflow-folders',
      'POST /v1/workspaces/{workspaceId}/workflow-folders/{folderId}/rename',
      'POST /v1/workspaces/{workspaceId}/workflow-folders/{folderId}/move',
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
