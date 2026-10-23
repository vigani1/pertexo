import { randomBytes, randomUUID } from 'node:crypto';

import type {
  ConnectionSecretContext,
  EnvelopeKeyProvider,
} from '../../src/server.js';
export const context = (): ConnectionSecretContext => ({
  workspaceId: randomUUID(),
  connectionId: randomUUID(),
  secretVersionId: randomUUID(),
});
export class ContextBoundKeyProvider implements EnvelopeKeyProvider {
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
