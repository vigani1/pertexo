import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  workflowCallableTargetsQuerySchema,
  workflowCallableTargetsResponseSchema,
  workflowCallableTargetsUnavailableProblemSchema,
  workflowVersionsQuerySchema,
  workflowVersionsResponseSchema,
  workflowVersionsReadQuerySchema,
  workflowVersionsReadResponseSchema,
} from '../src/http/workflow-authoring.js';
import {
  workflowAuthoringClientContract,
  workflowAuthoringOpenApiDocument,
} from '../src/workflow-authoring.js';
import {
  apiProblemCodeSchema,
  apiProblemSchema,
} from '../src/errors/api-problem.js';

const workflowId = '11111111-1111-4111-8111-111111111111';
const versionId = '22222222-2222-4222-8222-222222222222';
const workspaceId = '33333333-3333-4333-8333-333333333333';
const descriptor = { type: 'object', properties: {}, required: [] };
const pin = {
  workflowId,
  versionId,
  checksum: `wf:v3:sha256:${'a'.repeat(64)}`,
  callableContractIdentity: `callable:v1:sha256:${'b'.repeat(64)}`,
};
function projection() {
  return {
    projection: 'callableTarget',
    workspaceId,
    permissions: { canEditDraft: false, canUseInPublication: false },
    items: [
      {
        id: versionId,
        workflowId,
        versionNumber: 1,
        publishedAt: '2026-10-04T00:00:00.000Z',
        callableTarget: {
          pin,
          contract: { input: descriptor, result: descriptor },
          eligibility: { status: 'eligible' },
        },
      },
    ],
    nextCursor: null,
  };
}

describe('callable target opt-in public contracts (source only)', () => {
  it('agrees across runtime, generated client and OpenAPI for recursive descriptors', () => {
    const client = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile({
      $ref: '#/schemas/WorkflowCallableTargetsResponse',
      schemas: workflowAuthoringClientContract.schemas,
    });
    const openapi = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile({
      $ref: '#/components/schemas/WorkflowCallableTargetsResponse',
      components: {
        schemas: workflowAuthoringOpenApiDocument.components.schemas,
      },
    });
    const nestedObject = {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    };
    const valid = [
      nestedObject,
      { type: 'array', maxItems: 3, items: nestedObject },
      {
        type: 'array',
        maxItems: 2,
        items: { type: 'array', maxItems: 3, items: nestedObject },
      },
    ];
    const invalid = [
      { ...nestedObject, unknown: true },
      { type: 'array', maxItems: 1001, items: nestedObject },
      {
        type: 'array',
        maxItems: 3,
        items: {
          ...nestedObject,
          properties: { value: { type: 'unsupported' } },
        },
      },
      {
        type: 'array',
        maxItems: 2,
        items: {
          type: 'array',
          maxItems: 3,
          items: {
            type: 'object',
            properties: { value: { type: 'string', resultSelector: {} } },
            required: [],
          },
        },
      },
      projection(),
    ];
    for (const field of ['input', 'result'] as const) {
      for (const [expected, values] of [
        [true, valid],
        [false, invalid],
      ] as const) {
        for (const child of values) {
          const response = projection();
          const item = response.items[0];
          if (item === undefined) throw new Error('Missing fixture version');
          const candidate = {
            ...response,
            items: [
              {
                ...item,
                callableTarget: {
                  ...item.callableTarget,
                  contract: {
                    ...item.callableTarget.contract,
                    [field]: {
                      type: 'object',
                      properties: { child },
                      required: ['child'],
                    },
                  },
                },
              },
            ],
          };
          expect(
            workflowCallableTargetsResponseSchema.safeParse(candidate).success,
          ).toBe(expected);
          expect(client(candidate), JSON.stringify(client.errors)).toBe(
            expected,
          );
          expect(openapi(candidate), JSON.stringify(openapi.errors)).toBe(
            expected,
          );
        }
      }
    }
  });
  it('generates resolvable strict projection alternatives and bounded structural descriptors', () => {
    const validate = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile({
      $ref: '#/schemas/WorkflowCallableTargetsResponse',
      schemas: workflowAuthoringClientContract.schemas,
    });
    const response = projection();
    expect(validate(response), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ items: [], nextCursor: null })).toBe(false);
    const item = response.items[0];
    if (item === undefined) throw new Error('Missing fixture version');
    expect(
      validate({
        ...response,
        items: [
          {
            ...item,
            callableTarget: {
              pin: null,
              contract: null,
              eligibility: { status: 'eligible' },
            },
          },
        ],
      }),
    ).toBe(false);
    expect(
      validate({
        ...response,
        items: [
          {
            ...item,
            callableTarget: {
              ...item.callableTarget,
              contract: { input: { type: 'string' }, result: descriptor },
            },
          },
        ],
      }),
    ).toBe(false);
    expect(
      validate({
        ...response,
        items: [
          {
            ...item,
            callableTarget: {
              ...item.callableTarget,
              contract: { ...item.callableTarget.contract, resultSelector: {} },
            },
          },
        ],
      }),
    ).toBe(false);
  });
  it('keeps the legacy grammar separate and bounds projection pages and exact refresh', () => {
    expect(workflowVersionsQuerySchema.parse({})).toEqual({});
    expect(workflowVersionsQuerySchema.parse({ limit: '100' })).toEqual({
      limit: 100,
    });
    expect(
      workflowCallableTargetsQuerySchema.parse({ include: 'callableTarget' }),
    ).toEqual({ include: 'callableTarget', limit: 1 });
    expect(
      workflowCallableTargetsQuerySchema.parse({
        include: 'callableTarget',
        limit: '25',
        after: 'opaque',
      }),
    ).toEqual({ include: 'callableTarget', limit: 25, after: 'opaque' });
    expect(
      workflowCallableTargetsQuerySchema.parse({
        include: 'callableTarget',
        versionId,
      }),
    ).toEqual({ include: 'callableTarget', versionId });
    for (const query of [
      {},
      { include: 'source' },
      { include: ['callableTarget'] },
      { include: 'callableTarget', limit: ['1'] },
      { include: 'callableTarget', limit: 0 },
      { include: 'callableTarget', limit: 26 },
      { include: 'callableTarget', limit: null },
      { include: 'callableTarget', versionId, limit: 1 },
      { include: 'callableTarget', versionId, after: 'opaque' },
      { include: 'callableTarget', versionId: 'latest' },
      { include: 'callableTarget', after: ['opaque'] },
      { include: 'callableTarget', unknown: true },
    ])
      expect(workflowCallableTargetsQuerySchema.safeParse(query).success).toBe(
        false,
      );
    expect(
      workflowVersionsQuerySchema.safeParse({ include: 'callableTarget' })
        .success,
    ).toBe(false);
    expect(workflowVersionsReadQuerySchema.parse({})).toEqual({});
    expect(
      workflowVersionsReadQuerySchema.parse({
        include: 'callableTarget',
        versionId,
      }),
    ).toEqual({ include: 'callableTarget', versionId });
    expect(
      workflowVersionsReadQuerySchema.safeParse({ versionId }).success,
    ).toBe(false);
  });

  it('allows inspect-only eligibility without claiming actor use or runtime authority', () => {
    expect(
      workflowCallableTargetsResponseSchema.parse(projection()),
    ).toMatchObject({
      permissions: { canEditDraft: false, canUseInPublication: false },
    });
    const legacy = { items: [], nextCursor: null };
    expect(workflowVersionsResponseSchema.parse(legacy)).toEqual(legacy);
    expect(
      workflowCallableTargetsResponseSchema.safeParse(legacy).success,
    ).toBe(false);
    expect(workflowVersionsResponseSchema.safeParse(projection()).success).toBe(
      false,
    );
    expect(
      workflowVersionsReadResponseSchema.parse(projection()),
    ).toMatchObject({ projection: 'callableTarget' });
    expect(workflowVersionsReadResponseSchema.parse(legacy)).toEqual(legacy);
  });

  it('requires complete exact immutable identity for eligible outcomes', () => {
    const response = projection();
    const item = response.items[0];
    if (item === undefined) throw new Error('Missing fixture version');
    for (const target of [
      { ...item.callableTarget, pin: null },
      { ...item.callableTarget, contract: null },
      { ...item.callableTarget, pin: null, contract: null },
      { ...item.callableTarget, pin: { ...pin, versionId: workspaceId } },
      { ...item.callableTarget, pin: { ...pin, workflowId: workspaceId } },
      {
        ...item.callableTarget,
        pin: { ...pin, checksum: `wf:v2:sha256:${'a'.repeat(64)}` },
      },
      {
        ...item.callableTarget,
        pin: { ...pin, callableContractIdentity: 'callable:v1:sha256:prefix' },
      },
      {
        ...item.callableTarget,
        eligibility: {
          status: 'eligible',
          reason: 'native_authoring_unavailable',
        },
      },
    ])
      expect(
        workflowCallableTargetsResponseSchema.safeParse({
          ...response,
          items: [{ ...item, callableTarget: target }],
        }).success,
      ).toBe(false);
  });

  it('admits only closed refusal reasons with paired verified or absent identity', () => {
    const response = projection();
    const item = response.items[0];
    if (item === undefined) throw new Error('Missing fixture version');
    for (const [status, reasons] of [
      [
        'ineligible',
        [
          'not_native_executable',
          'not_callable',
          'workflow_inactive',
          'current_compatibility_denied',
          'dependency_ineligible',
        ],
      ],
      [
        'unavailable',
        [
          'native_authoring_unavailable',
          'compatibility_support_unavailable',
          'dependency_assessment_unavailable',
        ],
      ],
    ] as const)
      for (const reason of reasons)
        for (const identity of [
          { pin, contract: item.callableTarget.contract },
          { pin: null, contract: null },
        ])
          expect(
            workflowCallableTargetsResponseSchema.safeParse({
              ...response,
              items: [
                {
                  ...item,
                  callableTarget: {
                    ...identity,
                    eligibility: { status, reason },
                  },
                },
              ],
            }).success,
          ).toBe(true);
    for (const eligibility of [
      { status: 'ineligible', reason: 'native_authoring_unavailable' },
      { status: 'unavailable', reason: 'workflow_inactive' },
      { status: 'unavailable', reason: 'SQL failed' },
      { status: 'ineligible' },
    ])
      expect(
        workflowCallableTargetsResponseSchema.safeParse({
          ...response,
          items: [
            {
              ...item,
              callableTarget: { pin: null, contract: null, eligibility },
            },
          ],
        }).success,
      ).toBe(false);
  });

  it('rejects executable payloads, unknown scope fields and unbounded descriptors/pages', () => {
    const response = projection();
    const item = response.items[0];
    if (item === undefined) throw new Error('Missing fixture version');
    for (const modified of [
      { ...response, actorId: workspaceId },
      { ...response, permissions: { ...response.permissions, canRun: true } },
      { ...response, items: Array.from({ length: 26 }, () => item) },
      { ...response, items: [{ ...item, graph: {} }] },
      {
        ...response,
        items: [
          {
            ...item,
            callableTarget: {
              ...item.callableTarget,
              contract: {
                ...item.callableTarget.contract,
                resultSelector: { kind: 'literal', value: {} },
              },
            },
          },
        ],
      },
      {
        ...response,
        items: [
          {
            ...item,
            callableTarget: {
              ...item.callableTarget,
              contract: {
                input: {
                  type: 'object',
                  properties: {
                    x: {
                      type: 'array',
                      items: { type: 'string' },
                      maxItems: 1001,
                    },
                  },
                  required: [],
                },
                result: descriptor,
              },
            },
          },
        ],
      },
    ])
      expect(
        workflowCallableTargetsResponseSchema.safeParse(modified).success,
      ).toBe(false);
    let deep: unknown = { type: 'string' };
    for (let index = 0; index < 500; index += 1)
      deep = { type: 'array', items: deep, maxItems: 1 };
    const hostile = {
      ...response,
      items: [
        {
          ...item,
          callableTarget: {
            ...item.callableTarget,
            contract: {
              input: { type: 'object', properties: { deep }, required: [] },
              result: descriptor,
            },
          },
        },
      ],
    };
    expect(() =>
      workflowCallableTargetsResponseSchema.safeParse(hostile),
    ).not.toThrow(RangeError);
    expect(
      workflowCallableTargetsResponseSchema.safeParse(hostile).success,
    ).toBe(false);
  });

  it('registers one additive 503 problem without changing existing failure codes', () => {
    const problem = {
      type: 'urn:pertexo:problem:workflow.callable_targets_unavailable',
      title: 'Workflow callable targets unavailable',
      status: 503,
      code: 'workflow.callable_targets_unavailable',
      requestId: 'request-1',
      detail: 'assessment_budget_exhausted',
    };
    expect(
      workflowCallableTargetsUnavailableProblemSchema.parse(problem),
    ).toEqual(problem);
    expect(apiProblemSchema.parse(problem)).toEqual(problem);
    expect(apiProblemCodeSchema.parse('workflow.validation_unavailable')).toBe(
      'workflow.validation_unavailable',
    );
    for (const delta of [
      { status: 200 },
      { code: 'internal.unexpected' },
      { pin },
      { items: [] },
    ])
      expect(
        workflowCallableTargetsUnavailableProblemSchema.safeParse({
          ...problem,
          ...delta,
        }).success,
      ).toBe(false);
  });

  it('documents the same GET operation with disjoint response alternatives and explicit narrowing', () => {
    const get =
      workflowAuthoringOpenApiDocument.paths[
        '/v1/workspaces/{workspaceId}/workflows/{workflowId}/versions'
      ].get;
    expect(get.operationId).toBe('listWorkflowVersions');
    expect(get.parameters.map(({ name }) => name)).toEqual([
      'workspaceId',
      'workflowId',
      'limit',
      'after',
      'include',
      'versionId',
    ]);
    expect(
      get.responses['200'].content['application/json'].schema.oneOf,
    ).toEqual([
      { $ref: '#/components/schemas/WorkflowVersionsResponse' },
      { $ref: '#/components/schemas/WorkflowCallableTargetsResponse' },
    ]);
    expect(get.description).toContain('Raw generated callers must narrow');
    expect(
      get.responses['503'].content['application/problem+json'].schema,
    ).toEqual({
      $ref: '#/components/schemas/WorkflowCallableTargetsUnavailableProblem',
    });
    expect(
      workflowAuthoringClientContract.schemas.WorkflowCallableTargetsResponse,
    ).toHaveProperty('additionalProperties', false);
    expect(
      workflowAuthoringClientContract.schemas.WorkflowVersionsResponse,
    ).not.toHaveProperty('properties.projection');
  });
});
