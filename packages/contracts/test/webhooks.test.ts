import { readFileSync } from 'node:fs';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import {
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
  components: { schemas: { WebhookManagementCommandResponse: object } };
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

describe('webhook public contracts', () => {
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
