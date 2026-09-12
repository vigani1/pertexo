import { randomBytes, randomUUID } from 'node:crypto';

import { GenerateDataKeyCommand } from '@aws-sdk/client-kms';
import { describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  createBoundedKmsClient: vi.fn(),
}));

vi.mock('../src/credentials/kms-client.js', () => ({
  createBoundedKmsClient: fixtures.createBoundedKmsClient,
}));

import { createAwsConnectionEnvelopeEncryption } from '../src/server.js';

const identity = {
  workspaceId: randomUUID(),
  connectionId: randomUUID(),
  secretVersionId: randomUUID(),
};

describe('AWS connection envelope runtime factory', () => {
  it('validates config before construction and accepts only bounded fields', () => {
    for (const invalid of [
      {},
      { keyReference: '', region: 'eu-central-1' },
      { keyReference: 'alias/pertexo', region: '' },
      {
        keyReference: 'alias/pertexo',
        region: 'eu-central-1',
        endpoint: 'not-url',
      },
      {
        keyReference: 'alias/pertexo',
        region: 'eu-central-1',
        unexpected: true,
      },
    ]) {
      expect(() =>
        createAwsConnectionEnvelopeEncryption(invalid as never),
      ).toThrow();
    }
    expect(fixtures.createBoundedKmsClient).not.toHaveBeenCalled();
  });

  it('constructs a bounded client, binds the configured key, and closes it publicly', async () => {
    const send = vi.fn().mockResolvedValue({
      Plaintext: randomBytes(32),
      CiphertextBlob: randomBytes(96),
      KeyId: 'alias/pertexo',
    });
    const destroy = vi.fn();
    const client = { send, destroy };
    fixtures.createBoundedKmsClient.mockReturnValueOnce(client);

    const runtime = createAwsConnectionEnvelopeEncryption({
      keyReference: 'alias/pertexo',
      region: 'eu-central-1',
      endpoint: 'http://kms.test.invalid',
    });
    expect(fixtures.createBoundedKmsClient).toHaveBeenCalledWith({
      keyReference: 'alias/pertexo',
      region: 'eu-central-1',
      endpoint: 'http://kms.test.invalid',
    });
    expect(Object.isFrozen(runtime)).toBe(true);

    const plaintext = new TextEncoder().encode('connection secret');
    await runtime.encryption.seal(plaintext, identity);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GenerateDataKeyCommand);
    expect(
      (send.mock.calls[0]?.[0] as GenerateDataKeyCommand).input,
    ).toMatchObject({
      KeyId: 'alias/pertexo',
      KeySpec: 'AES_256',
      EncryptionContext: {
        purpose: 'pertexo-connection-secret',
        schemaVersion: '1',
        workspaceId: identity.workspaceId,
        connectionId: identity.connectionId,
        secretVersionId: identity.secretVersionId,
      },
    });

    runtime.close();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
