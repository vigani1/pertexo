import { readFileSync } from 'node:fs';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import {
  webhookDeliveryListQuerySchema,
  webhookDeliveryListResponseSchema,
  webhookIngressResponseSchema,
  webhookManagementCommandResponseSchema,
} from '../src/http/webhooks.js';
import {
  webhooksClientContract,
  webhooksOpenApiDocument,
} from '../src/webhooks.js';

type OpenApiOperation = Readonly<{
  parameters?: readonly Readonly<Record<string, unknown>>[];
  responses: Readonly<Record<string, unknown>>;
  security?: readonly Readonly<Record<string, readonly unknown[]>>[];
}>;

const trigger = Object.freeze({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  workflowId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  workflowVersionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  nodeId: 'trigger',
  kind: 'webhook' as const,
  status: 'active' as const,
  healthStatus: 'healthy' as const,
  lastErrorCode: null,
  endpointReady: true,
  reconciledAt: null,
});

const generatedDocument = JSON.parse(
  readFileSync(
    new URL('../artifacts/webhooks.openapi.json', import.meta.url),
    'utf8',
  ),
) as {
  components: {
    schemas: {
      WebhookDeliveryListResponse: object;
      WebhookManagementCommandResponse: object;
    };
  };
};
const generatedValidator = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: false,
}).compile(
  generatedDocument.components.schemas.WebhookManagementCommandResponse,
);

function expectRuntimeAndGenerated(value: unknown, accepted: boolean): void {
  expect(webhookManagementCommandResponseSchema.safeParse(value).success).toBe(
    accepted,
  );
  expect(
    generatedValidator(value),
    JSON.stringify(generatedValidator.errors),
  ).toBe(accepted);
}

const generatedDeliveryValidator = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: false,
}).compile(generatedDocument.components.schemas.WebhookDeliveryListResponse);

describe('webhook public contracts', () => {
  it('keeps the delivery log metadata-only, strict and bounded', () => {
    const accepted = {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      receivedAt: '2026-09-25T10:00:00.123456Z',
      outcome: 'accepted',
      httpStatus: 202,
      signatureCheck: 'verified',
      replayCheck: 'new',
      byteLength: 321,
      runId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    };
    const rejected = {
      ...accepted,
      outcome: 'authentication_failed',
      httpStatus: 401,
      signatureCheck: 'mismatch',
      replayCheck: 'not_checked',
      byteLength: null,
      runId: null,
    };
    for (const [value, valid] of [
      [{ items: [accepted, rejected], nextCursor: 'opaque' }, true],
      [{ items: [], nextCursor: null }, true],
      [{ items: [{ ...accepted, headers: {} }], nextCursor: null }, false],
      [
        { items: [{ ...accepted, byteLength: 262_145 }], nextCursor: null },
        false,
      ],
      [
        { items: [{ ...accepted, outcome: 'queued' }], nextCursor: null },
        false,
      ],
      [{ items: [accepted] }, false],
    ] as const) {
      expect(webhookDeliveryListResponseSchema.safeParse(value).success).toBe(
        valid,
      );
      expect(
        generatedDeliveryValidator(value),
        JSON.stringify(generatedDeliveryValidator.errors),
      ).toBe(valid);
    }
    expect(webhookDeliveryListQuerySchema.parse({ limit: '25' })).toEqual({
      limit: 25,
    });
    for (const query of [{ limit: '0' }, { limit: '101' }, { cursor: 'x' }])
      expect(webhookDeliveryListQuerySchema.safeParse(query).success).toBe(
        false,
      );
  });

  it('accepts replay only when credential values are absent', () => {
    expectRuntimeAndGenerated({ trigger, replayed: true }, true);
    for (const credentials of [
      { endpointKey: 'a'.repeat(43) },
      { signingSecret: 'b'.repeat(43) },
      { endpointKey: 'a'.repeat(43), signingSecret: 'b'.repeat(43) },
    ])
      expectRuntimeAndGenerated(
        { trigger, replayed: true, ...credentials },
        false,
      );
  });

  it('preserves all supported non-replay credential combinations', () => {
    for (const credentials of [
      {},
      { endpointKey: 'a'.repeat(43) },
      { signingSecret: 'b'.repeat(43) },
      { endpointKey: 'a'.repeat(43), signingSecret: 'b'.repeat(43) },
    ])
      expectRuntimeAndGenerated(
        { trigger, replayed: false, ...credentials },
        true,
      );
  });

  it('preserves explicit undefined for direct replay callers but rejects unknown fields', () => {
    expect(
      webhookManagementCommandResponseSchema.safeParse({
        trigger,
        replayed: true,
        endpointKey: undefined,
        signingSecret: undefined,
      }).success,
    ).toBe(true);
    expectRuntimeAndGenerated(
      { trigger, replayed: false, unexpected: true },
      false,
    );
  });

  it('keeps ingress success strict', () => {
    const response = {
      runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      replayed: false,
    };
    expect(webhookIngressResponseSchema.parse(response)).toEqual(response);
    expect(
      webhookIngressResponseSchema.safeParse({ ...response, secret: 'no' })
        .success,
    ).toBe(false);
  });

  it('documents guarded management and signed ingress metadata', () => {
    expect(
      webhooksOpenApiDocument.components.securitySchemes.cookieSession,
    ).toBeDefined();
    for (const route of webhooksClientContract.routes) {
      const path = route.path.replaceAll(/:([A-Za-z]+)/gu, '{$1}');
      const paths = webhooksOpenApiDocument.paths as unknown as Readonly<
        Record<string, Readonly<Record<string, OpenApiOperation>>>
      >;
      const operation = paths[path]?.[route.method.toLowerCase()];
      expect(operation?.responses).toHaveProperty(
        route.path.startsWith('/hooks/') ? '202' : '200',
      );
      for (const header of 'requiredHeaders' in route
        ? route.requiredHeaders
        : [])
        expect(operation?.parameters).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              in: 'header',
              name: header,
              required: true,
            }),
          ]),
        );
      if (!route.path.startsWith('/hooks/')) {
        expect(operation?.security).toEqual([{ cookieSession: [] }]);
        expect(operation?.responses).toHaveProperty('403');
      }
    }
  });
});
