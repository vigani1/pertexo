import {
  WebhookTriggerIdempotencyConflictError,
  type WebhookTriggerDatabase,
} from '@pertexo/database';
import type { WebhookTriggerEnvelopeEncryption } from '@pertexo/integrations/server';
import { describe, expect, it, vi } from 'vitest';

import { WebhookManagementService } from '../../src/webhooks/service.js';

const health = {
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
const input = {
  workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  triggerId: health.id,
  idempotencyKey: 'command-1',
};

describe('webhook management service', () => {
  it('passes only hashes and sealed secrets to persistence and discloses original credentials', async () => {
    const { service, database } = setup(true);
    const result = await service.provision(input);
    expect(result.endpointKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(result.signingSecret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const persisted = JSON.stringify(database.provision.mock.calls);
    expect(persisted).toMatch(/"endpointKeyHash":"[0-9a-f]{64}"/u);
    expect(persisted).toContain('"ciphertext":"sealed"');
    expect(persisted).not.toContain(result.endpointKey);
    expect(persisted).not.toContain(result.signingSecret);
  });

  it('returns no credentials when a completed command replay cannot prove ownership', async () => {
    const { service } = setup(false);
    await expect(service.provision(input)).resolves.toMatchObject({
      replayed: true,
    });
    const result = await service.rotateSecret({
      ...input,
      endpointKey: 'a'.repeat(43),
    });
    expect(result).not.toHaveProperty('signingSecret');
  });

  it('discloses a rotated secret only when the supplied endpoint proves the new version is current', async () => {
    const { service, database } = setup(true);
    const endpointKey = 'a'.repeat(43);
    const result = await service.rotateSecret({
      ...input,
      endpointKey,
    });
    expect(result.replayed).toBe(false);
    expect(result.signingSecret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(result).not.toHaveProperty('endpointKey');
    expect(JSON.stringify(database.rotateSecret.mock.calls)).not.toContain(
      endpointKey,
    );
  });

  it('maps management command idempotency conflicts to the stable public code', async () => {
    const { service, database } = setup(true);
    database.provision.mockRejectedValueOnce(
      new WebhookTriggerIdempotencyConflictError(),
    );
    await expect(service.provision(input)).rejects.toMatchObject({
      code: 'request.idempotency_conflict',
    });
  });
});

function setup(original: boolean) {
  const rotateSecret = vi.fn().mockResolvedValue(health);
  const provision = vi.fn().mockImplementation((input: unknown) => {
    void input;
    return Promise.resolve(health);
  });
  const database = {
    provision,
    rotateEndpoint: vi.fn().mockResolvedValue(health),
    rotateSecret,
    resolveVerification: vi.fn().mockImplementation(() => {
      const rotated = rotateSecret.mock.calls.at(-1)?.[0] as
        { secret?: { id: string } } | undefined;
      return Promise.resolve(
        original
          ? {
              triggerId: health.id,
              currentSecret: { id: rotated?.secret?.id ?? 'unused' },
            }
          : null,
      );
    }),
  };
  const encryption = {
    seal: vi.fn().mockImplementation((secret: Uint8Array) => {
      secret.fill(0);
      return Promise.resolve({
        schemaVersion: 1,
        kmsKeyReference: 'key',
        encryptedDataKey: 'encrypted-key',
        ciphertext: 'sealed',
        nonce: 'nonce',
        authTag: 'tag',
      });
    }),
  } as unknown as WebhookTriggerEnvelopeEncryption;
  return {
    service: new WebhookManagementService(
      database as unknown as WebhookTriggerDatabase,
      encryption,
    ),
    database,
  };
}
