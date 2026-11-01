import { problemResult } from '../../support/problem.js';
import { WebhookTriggerIdempotencyConflictError } from '@pertexo/core/testing';
import { webhookTriggerListResponseSchema } from '@pertexo/contracts';

import { expect, it } from 'vitest';

import {
  health,
  input,
  setup,
  publicHealthFixture,
  expectWiped,
} from './fixture.js';

export function registerPassesHashesSealedSecretsPersistenceDiscloses(): void {
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

  it('reveals mode-change credentials only once and hides the unused secret in URL mode', async () => {
    const f = setup(true);
    const authentication = {
      mode: 'secret_url' as const,
      allowedOrigins: ['https://app.example'],
    };
    const healthForMode = { ...health, authentication };
    f.database.configureAuthentication.mockResolvedValueOnce({
      trigger: healthForMode,
      replayed: false,
      rotated: true,
    });
    const result = await f.service.configureAuthentication({
      ...input,
      authentication,
    });
    expect(result.replayed).toBe(false);
    expect(result.endpointKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(result.signingSecret).toBeUndefined();
    expectWiped(f.generated);
    f.database.configureAuthentication.mockResolvedValueOnce({
      trigger: healthForMode,
      replayed: true,
      rotated: false,
    });
    expect(
      await f.service.configureAuthentication({ ...input, authentication }),
    ).toEqual({
      trigger: { ...publicHealthFixture(), authentication },
      replayed: true,
    });
    f.database.configureAuthentication.mockResolvedValueOnce({
      trigger: healthForMode,
      replayed: false,
      rotated: false,
    });
    expect(
      await f.service.configureAuthentication({ ...input, authentication }),
    ).toEqual({
      trigger: { ...publicHealthFixture(), authentication },
      replayed: false,
    });
  });

  it('maps management command idempotency conflicts to the stable public code', async () => {
    const { service, database } = setup(true);
    database.provision.mockRejectedValueOnce(
      new WebhookTriggerIdempotencyConflictError(),
    );
    await expect(problemResult(service.provision(input))).rejects.toMatchObject(
      {
        code: 'request.idempotency_conflict',
      },
    );
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
          authentication: { mode: 'signed', allowedOrigins: [] },
          reconciledAt: '2026-08-25T12:00:00.000Z',
        },
      ],
    });
    expect(webhookTriggerListResponseSchema.parse(result)).toEqual(result);
    expect(JSON.stringify(result)).not.toContain('internalSecretReference');
  });
}
