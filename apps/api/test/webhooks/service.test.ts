import {
  WebhookTriggerIdempotencyConflictError,
  WebhookTriggerNotFoundError,
  type WebhookTriggerDatabase,
  type WebhookVerificationReference,
} from '@pertexo/database/testing';
import {
  webhookManagementCommandResponseSchema,
  webhookTriggerListResponseSchema,
} from '@pertexo/contracts/webhooks';
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
  workflowId: health.workflowId,
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
    const persisted = database.rotateSecret.mock.calls[0]?.[0] as
      { endpointKeyHash?: unknown } | undefined;
    expect(persisted?.endpointKeyHash).toEqual(
      expect.stringMatching(/^[0-9a-f]{64}$/u),
    );
  });

  it('binds secret rotation idempotency to the supplied endpoint key', async () => {
    const { service, database } = setup(true);
    await service.rotateSecret({ ...input, endpointKey: 'a'.repeat(43) });
    await service.rotateSecret({ ...input, endpointKey: 'b'.repeat(43) });
    const requests = database.rotateSecret.mock.calls.map(
      ([request]) => (request as { requestHash: string }).requestHash,
    );
    expect(requests[0]).not.toBe(requests[1]);
  });

  it.each(['provision', 'rotateEndpoint'] as const)(
    'keeps %s idempotency stable across generated endpoint material',
    async (operation) => {
      const { service, database } = setup(true);
      await service[operation](input);
      await service[operation](input);
      const requests = database[operation].mock.calls.map(
        ([request]) => (request as { requestHash: string }).requestHash,
      );

      expect(requests[0]).toBe(requests[1]);
    },
  );

  it('binds generated-material commands to their operation and target', async () => {
    const { service, database } = setup(true);
    await service.provision(input);
    await service.rotateEndpoint(input);
    await service.provision({ ...input, triggerId: health.workflowVersionId });

    const provisionRequests = database.provision.mock.calls.map(
      ([request]) => (request as { requestHash: string }).requestHash,
    );
    const endpointRotation = database.rotateEndpoint.mock.calls[0]?.[0] as
      { requestHash: string } | undefined;
    expect(provisionRequests[0]).not.toBe(endpointRotation?.requestHash);
    expect(provisionRequests[0]).not.toBe(provisionRequests[1]);
  });

  it('threads the URL parent through every mutation and its idempotency identity', async () => {
    const { service, database } = setup(true);
    await service.provision(input);
    await service.rotateEndpoint(input);
    await service.rotateSecret({ ...input, endpointKey: 'a'.repeat(43) });
    for (const operation of [
      database.provision,
      database.rotateEndpoint,
      database.rotateSecret,
    ]) {
      expect(operation).toHaveBeenCalledWith(
        expect.objectContaining({ workflowId: health.workflowId }),
      );
    }

    await service.provision({ ...input, workflowId: health.workflowVersionId });
    const requests = database.provision.mock.calls.map(
      ([request]) => (request as { requestHash: string }).requestHash,
    );
    expect(requests[0]).not.toBe(requests[1]);
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

  it('lists only explicitly projected webhook health fields', async () => {
    const fixture = setup(true);
    const healthWithInternalField = {
      ...health,
      reconciledAt: new Date('2026-08-25T12:00:00.000Z'),
      internalSecretReference: 'must-not-leak',
    };
    fixture.database.getHealth.mockResolvedValueOnce([
      healthWithInternalField,
      {
        ...health,
        id: '11111111-1111-4111-8111-111111111111',
        nodeId: 'schedule',
        kind: 'schedule',
        endpointReady: false,
      },
    ]);

    const result = await fixture.service.list({
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      workflowId: input.workflowId,
    });

    expect(result).toEqual({
      items: [
        {
          id: health.id,
          workflowId: health.workflowId,
          workflowVersionId: health.workflowVersionId,
          nodeId: health.nodeId,
          kind: 'webhook',
          status: health.status,
          healthStatus: health.healthStatus,
          lastErrorCode: null,
          endpointReady: true,
          reconciledAt: '2026-08-25T12:00:00.000Z',
        },
      ],
    });
    expect(webhookTriggerListResponseSchema.parse(result)).toEqual(result);
    expect(JSON.stringify(result)).not.toContain('internalSecretReference');
  });

  it.each([
    {
      operation: 'provision' as const,
      execute: (service: WebhookManagementService) => service.provision(input),
      disclosed: ['endpointKey', 'signingSecret'],
      materialCount: 2,
    },
    {
      operation: 'rotateEndpoint' as const,
      execute: (service: WebhookManagementService) =>
        service.rotateEndpoint(input),
      disclosed: ['endpointKey'],
      materialCount: 1,
    },
    {
      operation: 'rotateSecret' as const,
      execute: (service: WebhookManagementService) =>
        service.rotateSecret({ ...input, endpointKey: 'a'.repeat(43) }),
      disclosed: ['signingSecret'],
      materialCount: 1,
    },
  ])(
    '$operation discloses exactly its original credentials and wipes owned material',
    async ({ execute, disclosed, materialCount }) => {
      const fixture = setup(true);

      const result = await execute(fixture.service);

      expect(result.replayed).toBe(false);
      expect(
        Object.keys(result).filter((key) =>
          ['endpointKey', 'signingSecret'].includes(key),
        ),
      ).toEqual(disclosed);
      expect(webhookManagementCommandResponseSchema.parse(result)).toEqual(
        result,
      );
      expect(fixture.generated).toHaveLength(materialCount);
      expect(fixture.sealedInputs.every((value) => value.some(Boolean))).toBe(
        true,
      );
      expectWiped(fixture.generated);
    },
  );

  it.each([
    {
      operation: 'provision',
      execute: (service: WebhookManagementService) => service.provision(input),
    },
    {
      operation: 'rotateEndpoint',
      execute: (service: WebhookManagementService) =>
        service.rotateEndpoint(input),
    },
    {
      operation: 'rotateSecret',
      execute: (service: WebhookManagementService) =>
        service.rotateSecret({ ...input, endpointKey: 'a'.repeat(43) }),
    },
  ])(
    '$operation completed replay discloses no credentials',
    async ({ execute }) => {
      const fixture = setup(false);

      const result = await execute(fixture.service);

      expect(result).toEqual({
        trigger: publicHealthFixture(),
        replayed: true,
      });
      expect(webhookManagementCommandResponseSchema.parse(result)).toEqual(
        result,
      );
      expectWiped(fixture.generated);
    },
  );

  it.each([
    ['seal rejection', 'seal'] as const,
    ['persistence rejection', 'persistence'] as const,
    ['ownership proof rejection', 'proof'] as const,
  ])('wipes all provision material after %s', async (_name, stage) => {
    const fixture = setup(true);
    const failure = new Error(`${stage} failed`);
    if (stage === 'seal') fixture.seal.mockRejectedValueOnce(failure);
    if (stage === 'persistence')
      fixture.database.provision.mockRejectedValueOnce(failure);
    if (stage === 'proof')
      fixture.database.resolveVerification.mockRejectedValueOnce(failure);

    await expect(fixture.service.provision(input)).rejects.toBe(failure);

    expectWiped(fixture.generated);
  });

  it('wipes secret material and skips persistence when aborted after sealing', async () => {
    const fixture = setup(true);
    const abort = new AbortController();
    fixture.seal.mockImplementationOnce((secret: Uint8Array) => {
      fixture.sealedInputs.push(Uint8Array.from(secret));
      abort.abort();
      return Promise.resolve(sealedEnvelope());
    });

    await expect(
      fixture.service.rotateSecret({
        ...input,
        endpointKey: 'a'.repeat(43),
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(fixture.database.rotateSecret).not.toHaveBeenCalled();
    expectWiped(fixture.generated);
  });

  it('rejects a missing endpoint key before material, sealing, or persistence', () => {
    const fixture = setup(true);

    expect(() => fixture.service.rotateSecret({ ...input } as never)).toThrow();

    expect(fixture.generated).toHaveLength(0);
    expect(fixture.seal).not.toHaveBeenCalled();
    expect(fixture.database.rotateSecret).not.toHaveBeenCalled();
  });

  it('maps hidden not-found and preserves an unknown command error', async () => {
    const hidden = setup(true);
    hidden.database.rotateEndpoint.mockRejectedValueOnce(
      new WebhookTriggerNotFoundError(),
    );
    await expect(hidden.service.rotateEndpoint(input)).rejects.toMatchObject({
      code: 'resource.not_found',
    });

    const unknown = setup(true);
    const failure = new Error('unknown persistence failure');
    unknown.database.rotateEndpoint.mockRejectedValueOnce(failure);
    await expect(unknown.service.rotateEndpoint(input)).rejects.toBe(failure);
  });
});

function setup(original: boolean) {
  const generated: Buffer[] = [];
  let materialValue = 1;
  const rotateSecret = vi.fn().mockResolvedValue(health);
  const provision = vi
    .fn<WebhookTriggerDatabase['provision']>()
    .mockResolvedValue(health);
  const database = {
    provision,
    rotateEndpoint: vi
      .fn<WebhookTriggerDatabase['rotateEndpoint']>()
      .mockResolvedValue(health),
    rotateSecret,
    getHealth: vi
      .fn<WebhookTriggerDatabase['getHealth']>()
      .mockResolvedValue([health]),
    resolveVerification: vi
      .fn<WebhookTriggerDatabase['resolveVerification']>()
      .mockImplementation(() => {
        const rotated = rotateSecret.mock.calls.at(-1)?.[0] as
          { secret?: { id: string } } | undefined;
        return Promise.resolve(
          original ? verification(rotated?.secret?.id ?? 'unused') : null,
        );
      }),
    consumeIngressLimit: vi.fn().mockResolvedValue(undefined),
    acceptVerifiedDelivery: vi.fn(),
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

function publicHealthFixture() {
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
    reconciledAt: null,
  };
}

function sealedEnvelope() {
  return {
    schemaVersion: 1 as const,
    kmsKeyReference: 'key',
    encryptedDataKey: 'encrypted-key',
    ciphertext: 'sealed',
    nonce: 'nonce',
    authTag: 'tag',
  };
}

function expectWiped(buffers: readonly Uint8Array[]): void {
  for (const buffer of buffers)
    expect(Array.from(buffer)).toEqual(Array.from(new Uint8Array(32)));
}

function verification(secretVersionId: string): WebhookVerificationReference {
  return {
    endpointId: '11111111-1111-4111-8111-111111111111',
    endpointKeyHash: 'a'.repeat(64),
    workspaceId: input.workspaceId,
    triggerId: input.triggerId,
    workflowId: input.workflowId,
    workflowVersionId: health.workflowVersionId,
    nodeId: health.nodeId,
    databaseTime: new Date('2026-08-25T12:00:00.000Z'),
    currentSecret: {
      id: secretVersionId,
      schemaVersion: 1,
      kmsKeyReference: 'key',
      encryptedDataKey: 'encrypted-key',
      ciphertext: 'sealed',
      nonce: 'nonce',
      authTag: 'tag',
    },
  };
}
