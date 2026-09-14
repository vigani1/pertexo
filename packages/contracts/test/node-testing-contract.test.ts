import { CANONICAL_JSON_MAX_DEPTH } from '@pertexo/workflow-model/canonical-json';
import { describe, expect, it } from 'vitest';

import {
  NODE_TEST_JSON_MAX_DEPTH,
  nodeTestExecuteAcceptedResponseSchema,
  nodeTestRequestSchema,
  nodeValidationResponseSchema,
  previewRunResponseSchema,
} from '../src/http/node-testing.js';
import {
  nodeTestingClientContract,
  nodeTestingOpenApiDocument,
} from '../src/node-testing.js';

function nestedArray(depth: number): unknown {
  let value: unknown = null;
  for (let index = 0; index < depth; index += 1) value = [value];
  return value;
}

function nestedObject(depth: number): unknown {
  let value: unknown = null;
  for (let index = 0; index < depth; index += 1) value = { value };
  return value;
}

const disclosure = {
  sideEffectClass: 'unsafe' as const,
  mayContactProvider: true,
  mayCauseExternalSideEffect: true,
  dryRun: 'not_supported' as const,
};
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

describe('node-testing public contracts', () => {
  it('keeps the browser preflight depth identical to canonical server JSON', () => {
    expect(NODE_TEST_JSON_MAX_DEPTH).toBe(CANONICAL_JSON_MAX_DEPTH);
  });

  it.each([
    ['array', nestedArray],
    ['object', nestedObject],
  ] as const)(
    'accepts exact %s depth and rejects one level beyond',
    (_name, nest) => {
      expect(
        nodeTestRequestSchema.safeParse({
          mode: 'validate',
          expectedRevision: 4,
          sampleInput: nest(NODE_TEST_JSON_MAX_DEPTH),
        }).success,
      ).toBe(true);
      const result = nodeTestRequestSchema.safeParse({
        mode: 'validate',
        expectedRevision: 4,
        sampleInput: nest(NODE_TEST_JSON_MAX_DEPTH + 1),
      });
      expect(result.success).toBe(false);
      if (!result.success)
        expect(result.error.issues).toEqual([
          expect.objectContaining({ path: ['sampleInput'] }),
        ]);
    },
  );

  it.each([
    [
      'validate array',
      {
        mode: 'validate',
        expectedRevision: 4,
        sampleInput: JSON.parse(
          `${'['.repeat(10_000)}null${']'.repeat(10_000)}`,
        ) as unknown,
      },
      ['sampleInput'],
    ],
    [
      'manual object',
      {
        mode: 'test_execute',
        expectedRevision: 4,
        input: {
          kind: 'manual',
          value: JSON.parse(
            `${'{"value":'.repeat(10_000)}null${'}'.repeat(10_000)}`,
          ) as unknown,
        },
        acknowledgeSideEffects: true,
      },
      ['input', 'value'],
    ],
  ] as const)(
    'returns a Zod failure for deeply serialized %s input',
    (_name, request, path) => {
      let result:
        ReturnType<typeof nodeTestRequestSchema.safeParse> | undefined;
      expect(() => {
        result = nodeTestRequestSchema.safeParse(request);
      }).not.toThrow();
      expect(result?.success).toBe(false);
      if (result !== undefined && !result.success)
        expect(result.error.issues).toEqual([
          expect.objectContaining({ path: [...path] }),
        ]);
    },
  );

  it('rejects cycles and accessors without reading the accessor', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(
      nodeTestRequestSchema.safeParse({
        mode: 'validate',
        expectedRevision: 4,
        sampleInput: cyclic,
      }).success,
    ).toBe(false);

    let visits = 0;
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get() {
        visits += 1;
        throw new Error('must not escape');
      },
    });
    expect(() =>
      nodeTestRequestSchema.safeParse({
        mode: 'validate',
        expectedRevision: 4,
        sampleInput: accessor,
      }),
    ).not.toThrow();
    expect(visits).toBe(0);
  });

  it('rejects direct non-JSON values with an ordinary schema failure', () => {
    const sparse: unknown[] = [];
    sparse.length = 1;
    const arrayWithProperty: unknown[] = [];
    Object.defineProperty(arrayWithProperty, 'extra', {
      enumerable: true,
      value: true,
    });
    const objectWithSymbol = { value: true };
    Object.defineProperty(objectWithSymbol, Symbol('extra'), { value: true });
    for (const sampleInput of [
      1n,
      Symbol('value'),
      () => undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date(0),
      sparse,
      arrayWithProperty,
      objectWithSymbol,
    ]) {
      const result = nodeTestRequestSchema.safeParse({
        mode: 'validate',
        expectedRevision: 4,
        sampleInput,
      });
      expect(result.success, typeof sampleInput).toBe(false);
    }
  });

  it('returns a stable failure for hostile and revoked values', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys trap');
        },
      },
    );
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    for (const sampleInput of [hostile, proxy])
      expect(() =>
        nodeTestRequestSchema.safeParse({
          mode: 'validate',
          expectedRevision: 4,
          sampleInput,
        }),
      ).not.toThrow();
  });

  it('stops at the first excess-depth branch without inspecting later values', () => {
    let laterBranchVisits = 0;
    const laterBranch = new Proxy(
      {},
      {
        getPrototypeOf() {
          laterBranchVisits += 1;
          return Object.prototype;
        },
      },
    );
    const result = nodeTestRequestSchema.safeParse({
      mode: 'validate',
      expectedRevision: 4,
      sampleInput: {
        first: nestedArray(NODE_TEST_JSON_MAX_DEPTH),
        later: laterBranch,
      },
    });
    expect(result.success).toBe(false);
    expect(laterBranchVisits).toBe(0);
  });

  it('accepts representative JSON and preserves request union strictness', () => {
    for (const sampleInput of [
      undefined,
      null,
      true,
      42,
      'value',
      [],
      { customerId: 'customer-1' },
    ]) {
      const request = {
        mode: 'validate' as const,
        expectedRevision: 4,
        ...(sampleInput === undefined ? {} : { sampleInput }),
      };
      expect(nodeTestRequestSchema.safeParse(request).success).toBe(true);
    }
    expect(
      nodeTestRequestSchema.safeParse({
        mode: 'test_execute',
        expectedRevision: 4,
        input: { kind: 'manual', value: {} },
        acknowledgeSideEffects: true,
      }).success,
    ).toBe(true);
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
      { mode: 'validate', expectedRevision: 4, extra: true },
    ])
      expect(nodeTestRequestSchema.safeParse(request).success).toBe(false);
  });

  it('keeps bounded, secret-free response variants', () => {
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

  it('documents recursive input shape, runtime depth, and conditional idempotency', () => {
    expect(nodeTestingClientContract.schemaVersion).toBe('1.0.0');
    expect(Object.keys(nodeTestingOpenApiDocument.paths)).toEqual([
      '/v1/workspaces/{workspaceId}/workflows/{workflowId}/draft/nodes/{nodeId}/test',
      '/v1/workspaces/{workspaceId}/previews/{previewRunId}',
    ]);
    const projected = nodeTestingClientContract.schemas.NodeTestRequest as {
      oneOf: readonly { properties: Readonly<Record<string, unknown>> }[];
    };
    const sampleInput = projected.oneOf[0]?.properties.sampleInput;
    expect(sampleInput).toMatchObject({
      'x-pertexo-runtime-max-depth': NODE_TEST_JSON_MAX_DEPTH,
    });
    expect(
      typeof (sampleInput as Readonly<Record<string, unknown>> | undefined)
        ?.$defs,
    ).toBe('object');
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
});
