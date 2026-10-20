import { expect, it, vi } from 'vitest';
import { CreateConnectionUseCase } from '../../../src/connections/use-cases/management.js';
import { TestConnectionUseCase } from '../../../src/connections/use-cases/test-connection.js';
import type {
  ConnectionTestPersistence,
  ConnectionHttpClient,
} from '../../../src/connections/ports.js';
import {
  actor,
  authorization,
  commandPersistence,
  connectionTestPersistence,
  connectionId,
  record,
  sealed,
  secretVersionId,
  workspaceId,
} from '../support/use-case-fixture.js';

it('seals exact signing keys and tests local access without any provider request', async () => {
  const connection = record({
    providerKey: 'signing',
    authType: 'hmac_key',
    name: 'Orders signing',
  });
  const store = commandPersistence({
    createConnection: vi.fn().mockResolvedValue(connection),
  });
  let plaintext: Uint8Array | undefined;
  const seal = vi.fn((value: Uint8Array) => {
    plaintext = value;
    expect(JSON.parse(new TextDecoder().decode(value))).toEqual({
      type: 'hmac_key',
      signingKey: '  signing-key\n',
    });
    return Promise.resolve(sealed);
  });
  const created = await new CreateConnectionUseCase(store, authorization(), {
    seal,
  }).execute({
    actor,
    routeWorkspaceId: workspaceId,
    idempotencyKey: 'signing-create',
    request: {
      providerKey: 'signing',
      name: 'Orders signing',
      credential: { type: 'hmac_key', signingKey: '  signing-key\n' },
    },
  });
  expect(created).toMatchObject({
    providerKey: 'signing',
    authType: 'hmac_key',
  });
  expect(JSON.stringify(created)).not.toContain('signing-key');
  expect(plaintext?.every((value) => value === 0)).toBe(true);
  const secret = new TextEncoder().encode(
    JSON.stringify({ type: 'hmac_key', signingKey: '  signing-key\n' }),
  );
  const tests = connectionTestPersistence({
    resolveConnectionTestSecret: vi
      .fn()
      .mockResolvedValue({ connection, secretVersionId, sealed }),
    completeConnectionTest: vi.fn<
      ConnectionTestPersistence['completeConnectionTest']
    >((input) =>
      Promise.resolve({
        connection: {
          ...connection,
          lastTestedAt: new Date('2026-10-20T12:00:00Z'),
          lastHealthyAt: new Date('2026-10-20T12:00:00Z'),
        },
        outcome: input.outcome,
      }),
    ),
  });
  const execute = vi.fn<ConnectionHttpClient['execute']>();
  const tested = await new TestConnectionUseCase(
    tests,
    authorization(),
    { seal, open: () => Promise.resolve(secret) },
    { execute },
  ).execute({
    actor,
    routeWorkspaceId: workspaceId,
    connectionId,
    idempotencyKey: 'signing-test',
    request: { providerKey: 'signing' },
  });
  expect(tested).toMatchObject({
    outcome: { ok: true, httpStatus: 200 },
    connection: { health: { lastTestedAt: '2026-10-20T12:00:00.000Z' } },
  });
  expect(execute).not.toHaveBeenCalled();
  expect(tests.markConnectionTestDispatched).toHaveBeenCalledOnce();
  expect(secret.every((value) => value === 0)).toBe(true);
});
