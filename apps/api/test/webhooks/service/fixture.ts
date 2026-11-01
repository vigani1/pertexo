import type { WebhookTriggerDatabase } from '@pertexo/core/testing';

import type { WebhookTriggerEnvelopeEncryption } from '@pertexo/integrations/server';
import { expect, vi } from 'vitest';
import { WebhookManagementService } from '../../../src/webhooks/management/service.js';

export const health = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  workflowId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  workflowVersionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  nodeId: 'webhook',
  kind: 'webhook' as const,
  status: 'active' as const,
  healthStatus: 'healthy' as const,
  lastErrorCode: null,
  endpointReady: true,
  reconciledAt: null,
};

export const input = {
  workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  triggerId: health.id,
  workflowId: health.workflowId,
  idempotencyKey: 'command-1',
};

export function setup(original: boolean) {
  const generated: Buffer[] = [];
  let materialValue = 1;
  const result = { trigger: health, replayed: !original };
  const provision = vi
    .fn<WebhookTriggerDatabase['provision']>()
    .mockResolvedValue(result);
  const database = {
    configureAuthentication: vi
      .fn<WebhookTriggerDatabase['configureAuthentication']>()
      .mockResolvedValue({ trigger: health, replayed: false, rotated: true }),
    provision,
    rotateEndpoint: vi
      .fn<WebhookTriggerDatabase['rotateEndpoint']>()
      .mockResolvedValue(result),
    rotateSecret: vi
      .fn<WebhookTriggerDatabase['rotateSecret']>()
      .mockResolvedValue(result),
    getHealth: vi
      .fn<WebhookTriggerDatabase['getHealth']>()
      .mockResolvedValue([health]),
    resolveVerification: vi.fn<WebhookTriggerDatabase['resolveVerification']>(),
    consumeIngressLimit: vi.fn().mockResolvedValue(undefined),
    acceptVerifiedDelivery: vi.fn(),
    readResponse: vi
      .fn<WebhookTriggerDatabase['readResponse']>()
      .mockResolvedValue({ state: 'finished' }),
    listDeliveries: vi.fn<WebhookTriggerDatabase['listDeliveries']>(),
    recordRejectedDelivery: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  } satisfies WebhookTriggerDatabase;
  const sealedInputs: Uint8Array[] = [];
  const seal = vi.fn().mockImplementation((secret: Uint8Array) => {
    sealedInputs.push(Uint8Array.from(secret));
    return Promise.resolve(sealedEnvelope());
  });
  const encryption = {
    seal,
  } as unknown as WebhookTriggerEnvelopeEncryption;
  return {
    service: new WebhookManagementService(database, encryption, {
      generateMaterial: () => {
        const material = Buffer.alloc(32, materialValue);
        materialValue += 1;
        generated.push(material);
        return material;
      },
    }),
    database,
    encryption,
    seal,
    generated,
    sealedInputs,
  };
}

export function publicHealthFixture() {
  return {
    id: health.id,
    workflowId: health.workflowId,
    workflowVersionId: health.workflowVersionId,
    nodeId: health.nodeId,
    kind: health.kind,
    status: health.status,
    healthStatus: health.healthStatus,
    lastErrorCode: health.lastErrorCode,
    endpointReady: health.endpointReady,
    authentication: { mode: 'signed', allowedOrigins: [] },
    reconciledAt: null,
  };
}

export function sealedEnvelope() {
  return {
    kmsKeyReference: 'key',
    encryptedDataKey: 'encrypted-key',
    ciphertext: 'sealed',
    nonce: 'nonce',
    authTag: 'tag',
  };
}

export function expectWiped(buffers: readonly Uint8Array[]): void {
  for (const buffer of buffers)
    expect(Array.from(buffer)).toEqual(Array.from(new Uint8Array(32)));
}
