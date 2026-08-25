import { describe, expect, it } from 'vitest';

import {
  webhookIngressResponseSchema,
  webhookManagementCommandResponseSchema,
} from '../src/http/webhooks.js';

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
});
