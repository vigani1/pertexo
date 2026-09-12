import { randomBytes, randomUUID } from 'node:crypto';

import { DecryptCommand, GenerateDataKeyCommand } from '@aws-sdk/client-kms';
import { describe, expect, it } from 'vitest';

import {
  AwsKmsEnvelopeKeyProvider,
  ConnectionEnvelopeEncryption,
  ConnectionSecretEncryptionError,
  type ConnectionSecretContext,
  type EnvelopeKeyProvider,
  type KmsCommand,
} from '../src/server.js';

const context = (): ConnectionSecretContext => ({
  workspaceId: randomUUID(),
  connectionId: randomUUID(),
  secretVersionId: randomUUID(),
});

class ContextBoundKeyProvider implements EnvelopeKeyProvider {
  private readonly key = randomBytes(32);
  private expectedContext = '';
  public readonly issuedPlaintextKeys: Uint8Array[] = [];

  public generateDataKey(input: ConnectionSecretContext) {
    this.expectedContext = JSON.stringify(input);
    const plaintextKey = new Uint8Array(this.key);
    this.issuedPlaintextKeys.push(plaintextKey);
    return Promise.resolve({
      plaintextKey,
      encryptedDataKey: new TextEncoder().encode(this.expectedContext),
      keyReference: 'test-key',
    });
  }

  public decryptDataKey(
    encryptedDataKey: Uint8Array,
    keyReference: string,
    input: ConnectionSecretContext,
  ) {
    if (
      keyReference !== 'test-key' ||
      new TextDecoder().decode(encryptedDataKey) !== JSON.stringify(input) ||
      JSON.stringify(input) !== this.expectedContext
    )
      throw new Error('KMS encryption context mismatch');
    const plaintextKey = new Uint8Array(this.key);
    this.issuedPlaintextKeys.push(plaintextKey);
    return Promise.resolve(plaintextKey);
  }
}

describe('connection envelope encryption', () => {
  it('round trips bytes only with the exact authenticated identity context', async () => {
    const keyProvider = new ContextBoundKeyProvider();
    const encryption = new ConnectionEnvelopeEncryption(keyProvider);
    const identity = context();
    const plaintext = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 1,
        headers: { Authorization: 'secret' },
      }),
    );

    const sealed = await encryption.seal(plaintext, identity);

    await expect(encryption.open(sealed, identity)).resolves.toEqual(plaintext);
    await expect(
      encryption.open(sealed, { ...identity, workspaceId: randomUUID() }),
    ).rejects.toBeInstanceOf(ConnectionSecretEncryptionError);
    await expect(
      encryption.open(
        { ...sealed, ciphertext: `${sealed.ciphertext}A` },
        identity,
      ),
    ).rejects.toBeInstanceOf(ConnectionSecretEncryptionError);
    expect(keyProvider.issuedPlaintextKeys).not.toHaveLength(0);
    for (const key of keyProvider.issuedPlaintextKeys)
      expect([...key]).toEqual(new Array<number>(32).fill(0));
  });

  it('fails with one safe error for malformed or oversized material', async () => {
    const encryption = new ConnectionEnvelopeEncryption(
      new ContextBoundKeyProvider(),
    );
    await expect(encryption.seal(new Uint8Array(), context())).rejects.toEqual(
      expect.objectContaining({
        name: 'ConnectionSecretEncryptionError',
        message: 'Connection secret encryption failed',
      }),
    );
    await expect(
      encryption.seal(new Uint8Array(65_537), context()),
    ).rejects.toBeInstanceOf(ConnectionSecretEncryptionError);
  });
});

describe('AWS KMS envelope-key adapter', () => {
  it('binds every KMS operation to the exact connection encryption context', async () => {
    const commands: KmsCommand[] = [];
    const client = {
      send: (command: KmsCommand): Promise<unknown> => {
        commands.push(command);
        return Promise.resolve(
          command instanceof GenerateDataKeyCommand
            ? {
                Plaintext: randomBytes(32),
                CiphertextBlob: randomBytes(96),
                KeyId: 'arn:aws:kms:eu-central-1:123456789012:key/example',
              }
            : { Plaintext: randomBytes(32) },
        );
      },
    };
    const provider = new AwsKmsEnvelopeKeyProvider(client, 'alias/pertexo');
    const identity = context();

    const generated = await provider.generateDataKey(identity);
    await provider.decryptDataKey(
      generated.encryptedDataKey,
      generated.keyReference,
      identity,
    );

    expect(commands).toHaveLength(2);
    expect(commands[0]).toBeInstanceOf(GenerateDataKeyCommand);
    expect(commands[1]).toBeInstanceOf(DecryptCommand);
    for (const command of commands) {
      expect(command.input.EncryptionContext).toEqual({
        purpose: 'pertexo-connection-secret',
        schemaVersion: '1',
        workspaceId: identity.workspaceId,
        connectionId: identity.connectionId,
        secretVersionId: identity.secretVersionId,
      });
    }
    expect(commands[0]?.input).toMatchObject({
      KeyId: 'alias/pertexo',
      KeySpec: 'AES_256',
    });
    expect(commands[1]?.input).toMatchObject({
      KeyId: generated.keyReference,
      EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
    });
  });

  it('does not expose KMS failure details', async () => {
    const provider = new AwsKmsEnvelopeKeyProvider(
      {
        send: () => Promise.reject(new Error('sensitive upstream detail')),
      },
      'alias/pertexo',
    );

    const failure = await provider
      .generateDataKey(context())
      .catch((error: unknown) => error);
    expect(failure).toEqual(
      expect.objectContaining({
        name: 'ConnectionSecretEncryptionError',
        message: 'Connection secret encryption failed',
      }),
    );
    expect(failure).not.toHaveProperty('cause');
  });

  it.each([
    ['null response', null],
    ['primitive response', 'not-a-record'],
    ['missing plaintext', { CiphertextBlob: randomBytes(96) }],
    [
      'short plaintext',
      { Plaintext: randomBytes(31), CiphertextBlob: randomBytes(96) },
    ],
    ['missing ciphertext', { Plaintext: randomBytes(32) }],
    [
      'empty ciphertext',
      { Plaintext: randomBytes(32), CiphertextBlob: new Uint8Array() },
    ],
    [
      'invalid returned key reference',
      {
        Plaintext: randomBytes(32),
        CiphertextBlob: randomBytes(96),
        KeyId: '',
      },
    ],
  ])(
    'fails closed for a malformed GenerateDataKey %s',
    async (_name, reply) => {
      const provider = new AwsKmsEnvelopeKeyProvider(
        { send: () => Promise.resolve(reply) },
        'alias/pertexo',
      );

      await expect(provider.generateDataKey(context())).rejects.toEqual(
        expect.objectContaining({
          name: 'ConnectionSecretEncryptionError',
          message: 'Connection secret encryption failed',
        }),
      );
    },
  );

  it.each([
    ['null response', null],
    ['primitive response', 17],
    ['missing plaintext', {}],
    ['short plaintext', { Plaintext: randomBytes(31) }],
  ])('fails closed for a malformed Decrypt %s', async (_name, reply) => {
    const provider = new AwsKmsEnvelopeKeyProvider(
      { send: () => Promise.resolve(reply) },
      'alias/pertexo',
    );

    await expect(
      provider.decryptDataKey(randomBytes(96), 'alias/pertexo', context()),
    ).rejects.toBeInstanceOf(ConnectionSecretEncryptionError);
  });

  it('uses the configured key reference when KMS omits KeyId', async () => {
    const provider = new AwsKmsEnvelopeKeyProvider(
      {
        send: () =>
          Promise.resolve({
            Plaintext: randomBytes(32),
            CiphertextBlob: randomBytes(96),
          }),
      },
      'alias/pertexo',
    );

    await expect(provider.generateDataKey(context())).resolves.toMatchObject({
      keyReference: 'alias/pertexo',
    });
  });

  it('bounds key references by their UTF-8 byte length', async () => {
    const validMultibyteReference = '€'.repeat(682);
    const provider = new AwsKmsEnvelopeKeyProvider(
      {
        send: () =>
          Promise.resolve({
            Plaintext: randomBytes(32),
            CiphertextBlob: randomBytes(96),
          }),
      },
      validMultibyteReference,
    );

    await expect(provider.generateDataKey(context())).resolves.toMatchObject({
      keyReference: validMultibyteReference,
    });
    expect(
      () =>
        new AwsKmsEnvelopeKeyProvider(
          { send: () => Promise.resolve({}) },
          '€'.repeat(683),
        ),
    ).toThrow('KMS key reference is invalid');
  });

  it('omits KMS request options when no abort signal is supplied', async () => {
    const options: unknown[] = [];
    const provider = new AwsKmsEnvelopeKeyProvider(
      {
        send: (command: KmsCommand, requestOptions?: unknown) => {
          options.push(requestOptions);
          return Promise.resolve(
            command instanceof GenerateDataKeyCommand
              ? {
                  Plaintext: randomBytes(32),
                  CiphertextBlob: randomBytes(96),
                }
              : { Plaintext: randomBytes(32) },
          );
        },
      },
      'alias/pertexo',
    );
    const identity = context();
    const generated = await provider.generateDataKey(identity);
    await provider.decryptDataKey(
      generated.encryptedDataKey,
      generated.keyReference,
      identity,
    );

    expect(options).toEqual([undefined, undefined]);
  });

  it('forwards abort to KMS and zeroes plaintext returned after abort', async () => {
    const controller = new AbortController();
    const latePlaintext = randomBytes(32);
    let resolveKms: ((value: unknown) => void) | undefined;
    let observedSignal: AbortSignal | undefined;
    const provider = new AwsKmsEnvelopeKeyProvider(
      {
        send: (
          _command: KmsCommand,
          options?: Readonly<{ abortSignal?: AbortSignal }>,
        ) => {
          observedSignal = options?.abortSignal;
          return new Promise<unknown>((resolve) => {
            resolveKms = resolve;
          });
        },
      },
      'alias/pertexo',
    );

    const pending = provider.decryptDataKey(
      randomBytes(96),
      'alias/pertexo',
      context(),
      controller.signal,
    );
    await Promise.resolve();
    expect(observedSignal).toBe(controller.signal);
    controller.abort();
    resolveKms?.({ Plaintext: latePlaintext });

    await expect(pending).rejects.toBeInstanceOf(
      ConnectionSecretEncryptionError,
    );
    expect([...latePlaintext]).toEqual(new Array<number>(32).fill(0));
  });
});
