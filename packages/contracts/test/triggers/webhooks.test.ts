import { readFileSync } from 'node:fs';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import {
  webhookTestEventStartSchema,
  webhookTestEventStartedSchema,
  webhookTestEventSnapshotSchema,
  webhookDeliveryListQuerySchema,
  webhookDeliveryListResponseSchema,
  webhookIngressResponseSchema,
  webhookManagementCommandResponseSchema,
} from '../../src/schemas/triggers/webhooks.js';
import { webhooksOpenApiDocument } from '../../src/server.js';

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
  authentication: { mode: 'signed' as const, allowedOrigins: [] },
  endpointReady: true,
  reconciledAt: null,
});

const generatedDocument = JSON.parse(
  readFileSync(
    new URL('../../artifacts/webhooks.openapi.json', import.meta.url),
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
      [{ items: [{ ...accepted, headers: {} }], nextCursor: null }, true],
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
    expect(
      webhookDeliveryListResponseSchema.parse({
        items: [{ ...accepted, headers: { secret: 'private' } }],
        nextCursor: null,
      }),
    ).toEqual({ items: [accepted], nextCursor: null });
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

  it('preserves explicit undefined and strips unknown response fields', () => {
    expect(
      webhookManagementCommandResponseSchema.parse({
        trigger,
        replayed: false,
        unexpected: true,
      }),
    ).toEqual({ trigger, replayed: false });
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
      true,
    );
  });

  it('keeps ingress success bounded and sanitized', () => {
    const response = {
      runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      replayed: false,
    };
    expect(webhookIngressResponseSchema.parse(response)).toEqual(response);
    expect(
      webhookIngressResponseSchema.parse({ ...response, secret: 'no' }),
    ).toEqual(response);
  });

  it('documents guarded management and signed ingress metadata', () => {
    expect(
      webhooksOpenApiDocument.components.securitySchemes.cookieSession,
    ).toBeDefined();
    const paths = webhooksOpenApiDocument.paths as unknown as Readonly<
      Record<string, Readonly<Record<string, OpenApiOperation>>>
    >;
    for (const [path, methods] of Object.entries(paths)) {
      if (path.startsWith('/hooks/')) continue;
      for (const [method, operation] of Object.entries(methods)) {
        const token =
          (method === 'get' && !path.includes('webhook-test-events')) ||
          path.endsWith('/provision');
        expect(operation.security).toEqual(
          token
            ? [{ cookieSession: [] }, { apiToken: [] }]
            : [{ cookieSession: [] }],
        );
        expect(operation.responses).toHaveProperty('403');
        if (method !== 'get')
          expect(operation.parameters).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                in: 'header',
                name: 'x-csrf-token',
                required: !token,
              }),
            ]),
          );
      }
    }
  });
});

it('describes asynchronous coordination without exposing keys or pretending a run started', () => {
  const receipt = {
    coordinated: true,
    eventId: trigger.id,
    outcome: 'throttled',
    status: 'pending',
    reason: null,
  };
  expect(webhookIngressResponseSchema.parse(receipt)).toEqual(receipt);
  for (const extra of [
    { runId: trigger.id },
    { keyHash: 'a'.repeat(64) },
    { input: { secret: true } },
  ])
    expect(
      webhookIngressResponseSchema.parse({ ...receipt, ...extra }),
    ).toEqual(receipt);
});

it('bounds temporary webhook contracts and never rediscloses a credential in snapshots', () => {
  const authentication = { mode: 'signed', allowedOrigins: [] };
  expect(
    webhookTestEventStartSchema.safeParse({
      expectedDraftRevision: 0,
      authentication,
    }).success,
  ).toBe(false);
  expect(
    webhookTestEventStartSchema.safeParse({
      expectedDraftRevision: 1,
      authentication,
    }).success,
  ).toBe(true);
  const started = {
    id: trigger.id,
    path: `/hooks/${'a'.repeat(43)}/test`,
    expiresAt: new Date().toISOString(),
    authentication,
    signingSecret: 'b'.repeat(43),
  };
  expect(webhookTestEventStartedSchema.parse(started)).toEqual(started);
  expect(
    webhookTestEventStartedSchema.safeParse({
      ...started,
      path: 'https://untrusted.example/test',
    }).success,
  ).toBe(false);
  const snapshot = {
    state: 'captured',
    expiresAt: new Date().toISOString(),
    output: { kind: 'inline', value: { order: 17 } },
  };
  expect(webhookTestEventSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  expect(
    webhookTestEventSnapshotSchema.parse({
      ...snapshot,
      signingSecret: started.signingSecret,
    }),
  ).toEqual(snapshot);
});
