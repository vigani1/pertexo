import { expect, it } from 'vitest';
import {
  createInput,
  ownerA,
  ownerB,
  randomUUID,
  registerCurrentConnectionsFixture,
  workspaceA,
  workspaceB,
} from '../support/connections.js';
const connections = registerCurrentConnectionsFixture();
it('stores, isolates, rotates and revokes signing-key connections through the existing lifecycle', async () => {
  const input = createInput({
    providerKey: 'signing',
    authType: 'hmac_key',
    name: `Signing ${randomUUID()}`,
  });
  const created = await connections.api.createConnection(input);
  expect(created).toMatchObject({
    providerKey: 'signing',
    authType: 'hmac_key',
    status: 'active',
  });
  expect(
    await connections.api.readConnection({
      workspaceId: workspaceB,
      actorId: ownerB,
      connectionId: created.id,
    }),
  ).toBeNull();
  const scope = {
    workspaceId: workspaceA,
    connectionId: created.id,
    expectedProviderKey: 'signing',
    workerId: 'signing-worker',
    purpose: 'core.hmac.execute',
  };
  await expect(
    connections.worker.resolveConnectionSecret({
      ...scope,
      workspaceId: workspaceB,
    }),
  ).rejects.toMatchObject({ name: 'ConnectionUnavailableError' });
  const resolved = await connections.worker.resolveConnectionSecret(scope);
  expect(resolved.secretVersionId).toBe(input.secretVersionId);
  await connections.worker.assertConnectionSecretCurrent({
    ...scope,
    expectedAuthType: 'hmac_key',
    secretVersionId: input.secretVersionId,
  });
  const next = randomUUID();
  await connections.api.rotateConnectionSecret({
    workspaceId: workspaceA,
    actorId: ownerA,
    connectionId: created.id,
    secretVersionId: next,
    expectedCurrentSecretVersionId: input.secretVersionId,
    expectedAuthType: 'hmac_key',
    sealed: input.sealed,
    idempotencyKey: `rotate-${next}`,
    requestHash: 'b'.repeat(64),
  });
  await expect(
    connections.worker.assertConnectionSecretCurrent({
      ...scope,
      expectedAuthType: 'hmac_key',
      secretVersionId: input.secretVersionId,
    }),
  ).rejects.toMatchObject({ name: 'ConnectionUnavailableError' });
  expect(
    (await connections.worker.resolveConnectionSecret(scope)).secretVersionId,
  ).toBe(next);
  await connections.api.revokeConnection({
    workspaceId: workspaceA,
    actorId: ownerA,
    connectionId: created.id,
  });
  await expect(
    connections.worker.resolveConnectionSecret(scope),
  ).rejects.toMatchObject({ name: 'ConnectionUnavailableError' });
});
