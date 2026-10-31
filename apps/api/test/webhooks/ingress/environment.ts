import type { WebhookVerificationReference } from '@pertexo/database/testing';

export const endpointKey = 'a'.repeat(43);

export const currentSecret = new Uint8Array(32).fill(4);

export const previousSecret = new Uint8Array(32).fill(5);

export const now = new Date('2026-08-25T12:00:00.000Z');

export const timestamp = String(now.getTime() / 1000);

export const verification: WebhookVerificationReference = {
  endpointId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  endpointKeyHash: 'a'.repeat(64),
  workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  triggerId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  workflowId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  workflowVersionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  nodeId: 'webhook',
  databaseTime: now,
  authentication: { mode: 'signed', allowedOrigins: [] },
  currentSecret: sealed('11111111-1111-4111-8111-111111111111'),
  previousSecret: {
    ...sealed('22222222-2222-4222-8222-222222222222'),
    validUntil: new Date(now.getTime() + 1),
  },
};

function sealed(id: string) {
  return {
    id,
    triggerId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    kmsKeyReference: 'key',
    encryptedDataKey: 'key',
    ciphertext: 'ciphertext',
    nonce: 'nonce',
    authTag: 'tag',
  };
}
