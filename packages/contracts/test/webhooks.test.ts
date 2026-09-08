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

describe('webhook public contracts', () => {
  it('never permits credentials on a completed command replay', () => {
    expect(() =>
      webhookManagementCommandResponseSchema.parse({
        replayed: true,
        endpointKey: 'a'.repeat(43),
        trigger: {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          workflowId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          workflowVersionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          nodeId: 'trigger',
          kind: 'webhook',
          status: 'active',
          healthStatus: 'healthy',
          lastErrorCode: null,
          endpointReady: true,
          reconciledAt: null,
        },
      }),
    ).toThrow();
    expect(() =>
      webhookManagementCommandResponseSchema.parse({
        replayed: true,
        signingSecret: 'b'.repeat(43),
        trigger: {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          workflowId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          workflowVersionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          nodeId: 'trigger',
          kind: 'webhook',
          status: 'active',
          healthStatus: 'healthy',
          lastErrorCode: null,
          endpointReady: true,
          reconciledAt: null,
        },
      }),
    ).toThrow();
  });

  it('keeps ingress success strict', () => {
    expect(
      webhookIngressResponseSchema.parse({
        runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        replayed: false,
      }),
    ).toEqual({
      runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      replayed: false,
    });
    expect(() =>
      webhookIngressResponseSchema.parse({
        runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        replayed: false,
        secret: 'no',
      }),
    ).toThrow();
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
