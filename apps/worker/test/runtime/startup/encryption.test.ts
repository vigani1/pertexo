import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createConnectionEnvelopeEncryption } from '@pertexo/integrations/server';
import { createWorkerApplication } from '../../../src/app.js';
import { parseWorkerConfig } from '../../../src/config/worker.js';
import { workerEnvironment } from '../../support/worker-environment.js';

const key = Buffer.alloc(32, 7).toString('base64');
const config = (value = key) =>
  parseWorkerConfig({
    ...workerEnvironment,
    CONNECTION_ENCRYPTION_MODE: 'self-managed',
    CONNECTION_SELF_MANAGED_KEY: value,
    CONNECTION_SELF_MANAGED_KEY_VERSION: '1',
  });
const dependencies = {
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  },
  telemetry: {
    enabled: false,
    started: false,
    start: vi.fn(),
    shutdown: vi.fn(() => Promise.resolve()),
  },
};
async function record() {
  const workspaceId = randomUUID(),
    resourceId = randomUUID(),
    secretVersionId = randomUUID();
  const runtime = createConnectionEnvelopeEncryption({
    mode: 'self-managed',
    encryption: { current: { version: '1', key }, previous: [] },
  });
  try {
    const envelope = await runtime.encryption.seal(
      Buffer.from('fixture credential'),
      { workspaceId, connectionId: resourceId, secretVersionId },
    );
    return {
      kind: 'connection' as const,
      workspaceId,
      resourceId,
      secretVersionId,
      keyReference: envelope.kmsKeyReference,
      encryptedDataKey: envelope.encryptedDataKey,
    };
  } finally {
    runtime.close();
  }
}
describe('encryption verification before worker construction', () => {
  it('preserves verification and cleanup failures without starting Nest', async () => {
    const stored = await record();
    const cleanup = new Error('Fixture repository cleanup failed');
    const factories = {
      encryptionKeysRepository: () => ({
        read: () => Readable.from([stored]),
        close: () => Promise.reject(cleanup),
      }),
      databaseRuntime: () => {
        throw new Error('Regular pools must not start');
      },
      applicationContext: () =>
        Promise.reject(new Error('Nest must not start')),
    };
    await expect(
      createWorkerApplication(
        config(Buffer.alloc(32, 8).toString('base64')),
        dependencies,
        factories,
      ),
    ).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [{ code: 'unavailable_key_material' }, cleanup],
    });
  });

  it('refuses the wrong key before any regular pool or Nest background work starts', async () => {
    const stored = await record();
    const close = vi.fn(() => Promise.resolve());
    const factories = {
      encryptionKeysRepository: () => ({
        read: () => Readable.from([stored]),
        close,
      }),
      databaseRuntime: vi.fn(() => {
        throw new Error('Regular pools must not start');
      }),
      applicationContext: vi.fn(() =>
        Promise.reject(new Error('Nest must not start')),
      ),
    };
    await expect(
      createWorkerApplication(
        config(Buffer.alloc(32, 8).toString('base64')),
        dependencies,
        factories,
      ),
    ).rejects.toMatchObject({ code: 'unavailable_key_material' });
    expect(close).toHaveBeenCalledOnce();
    expect(factories.databaseRuntime).not.toHaveBeenCalled();
    expect(factories.applicationContext).not.toHaveBeenCalled();
  });
  it('closes successful verification before constructing ordinary runtime owners', async () => {
    const stored = await record();
    const events: string[] = [];
    const reached = new Error('Ordinary runtime construction reached');
    const factories = {
      encryptionKeysRepository: () => ({
        read: () => {
          events.push('read');
          return Readable.from([stored]);
        },
        close: () => {
          events.push('closed');
          return Promise.resolve();
        },
      }),
      databaseRuntime: () => {
        events.push('ordinary');
        throw reached;
      },
      applicationContext: () => Promise.reject(new Error('Unused context')),
    };
    await expect(
      createWorkerApplication(config(), dependencies, factories),
    ).rejects.toBe(reached);
    expect(events).toEqual(['read', 'closed', 'ordinary']);
  });
});
