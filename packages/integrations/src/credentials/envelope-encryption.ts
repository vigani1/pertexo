import type { KMSClient } from '@aws-sdk/client-kms';
import { z } from 'zod';
import {
  AwsKmsEnvelopeKeyProviderCore,
  EnvelopeCipher,
  encodedEnvelopeSchemaFields,
  type EnvelopeKeyMaterial,
  type EnvelopeKeyProviderCore,
  type KmsCommandLike,
  type KmsSendLike,
} from '../crypto/envelope-cipher.js';

const MAX_PLAINTEXT_BYTES = 65_536;

const contextSchema = z
  .object({
    workspaceId: z.uuid(),
    connectionId: z.uuid(),
    secretVersionId: z.uuid(),
  })
  .strict();

const sealedSchema = z
  .object({
    ...encodedEnvelopeSchemaFields,
    tag: z.string().min(1),
  })
  .strict();

export type ConnectionSecretContext = Readonly<z.output<typeof contextSchema>>;
export type SealedConnectionSecret = Readonly<z.output<typeof sealedSchema>>;
export type GeneratedEnvelopeKey = EnvelopeKeyMaterial;
export type KmsCommand = KmsCommandLike;
export type KmsClientLike = KmsSendLike;
export type EnvelopeKeyProvider =
  EnvelopeKeyProviderCore<ConnectionSecretContext>;

export class ConnectionSecretEncryptionError extends Error {
  public override readonly name = 'ConnectionSecretEncryptionError';

  public constructor() {
    super('Connection secret encryption failed');
  }
}

function failure(): ConnectionSecretEncryptionError {
  return new ConnectionSecretEncryptionError();
}

function kmsEncryptionContext(
  context: ConnectionSecretContext,
): Readonly<Record<string, string>> {
  return Object.freeze({
    purpose: 'pertexo-connection-secret',
    schemaVersion: '1',
    workspaceId: context.workspaceId,
    connectionId: context.connectionId,
    secretVersionId: context.secretVersionId,
  });
}

export function connectionSecretAssociatedData(
  context: ConnectionSecretContext,
): Uint8Array {
  const parsed = contextSchema.parse(context);
  return new TextEncoder().encode(
    [
      'pertexo:connection-secret:v1',
      parsed.workspaceId,
      parsed.connectionId,
      parsed.secretVersionId,
    ].join('\u0000'),
  );
}

export class AwsKmsEnvelopeKeyProvider implements EnvelopeKeyProvider {
  private readonly core: AwsKmsEnvelopeKeyProviderCore<ConnectionSecretContext>;

  public constructor(
    client: Pick<KMSClient, 'send'> | KmsClientLike,
    keyReference: string,
  ) {
    this.core = new AwsKmsEnvelopeKeyProviderCore(
      client,
      keyReference,
      (context) => kmsEncryptionContext(contextSchema.parse(context)),
      failure,
    );
  }

  public async generateDataKey(
    context: ConnectionSecretContext,
    signal?: AbortSignal,
  ): Promise<GeneratedEnvelopeKey> {
    try {
      return await this.core.generateDataKey(
        contextSchema.parse(context),
        signal,
      );
    } catch {
      throw failure();
    }
  }

  public async decryptDataKey(
    encryptedDataKey: Uint8Array,
    keyReference: string,
    context: ConnectionSecretContext,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    try {
      return await this.core.decryptDataKey(
        encryptedDataKey,
        keyReference,
        contextSchema.parse(context),
        signal,
      );
    } catch {
      throw failure();
    }
  }
}

export class ConnectionEnvelopeEncryption {
  private readonly cipher: EnvelopeCipher<ConnectionSecretContext>;

  public constructor(keys: EnvelopeKeyProvider) {
    this.cipher = new EnvelopeCipher(keys, {
      associatedData: connectionSecretAssociatedData,
      createFailure: failure,
      maximumPlaintextBytes: MAX_PLAINTEXT_BYTES,
    });
  }

  public async seal(
    plaintext: Uint8Array,
    context: ConnectionSecretContext,
    signal?: AbortSignal,
  ): Promise<SealedConnectionSecret> {
    try {
      const sealed = await this.cipher.seal(
        plaintext,
        contextSchema.parse(context),
        signal,
      );
      return sealedSchema.parse({
        schemaVersion: 1,
        kmsKeyReference: sealed.keyReference,
        encryptedDataKey: sealed.encryptedDataKey,
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
        tag: sealed.authTag,
      });
    } catch {
      throw failure();
    }
  }

  public async open(
    sealed: SealedConnectionSecret,
    context: ConnectionSecretContext,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    try {
      const parsed = sealedSchema.parse(sealed);
      return await this.cipher.open(
        {
          keyReference: parsed.kmsKeyReference,
          encryptedDataKey: parsed.encryptedDataKey,
          ciphertext: parsed.ciphertext,
          nonce: parsed.nonce,
          authTag: parsed.tag,
        },
        contextSchema.parse(context),
        signal,
      );
    } catch {
      throw failure();
    }
  }
}
