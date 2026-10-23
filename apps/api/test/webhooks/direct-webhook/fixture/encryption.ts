import { createHash, createHmac } from 'node:crypto';

import type { WebhookEnvelopeKeyProvider } from '@pertexo/integrations/server';

export class DeterministicEnvelopeKeys implements WebhookEnvelopeKeyProvider {
  readonly #master = new Uint8Array(32).fill(0x6d);

  public generateDataKey(
    context: Parameters<WebhookEnvelopeKeyProvider['generateDataKey']>[0],
  ) {
    const plaintextKey = this.plaintextKey(context);
    return Promise.resolve({
      plaintextKey,
      encryptedDataKey: new Uint8Array(plaintextKey),
      keyReference: 'in-process://webhook-integration-v1',
    });
  }

  public decryptDataKey(encryptedDataKey: Uint8Array, keyReference: string) {
    if (
      keyReference !== 'in-process://webhook-integration-v1' ||
      encryptedDataKey.byteLength !== 32
    )
      return Promise.reject(new Error('Envelope key context mismatch'));
    return Promise.resolve(new Uint8Array(encryptedDataKey));
  }

  private plaintextKey(
    context: Parameters<WebhookEnvelopeKeyProvider['generateDataKey']>[0],
  ) {
    return new Uint8Array(
      createHmac('sha256', this.#master).update(contextBytes(context)).digest(),
    );
  }
}

function contextBytes(context: {
  workspaceId: string;
  triggerId: string;
  secretVersionId: string;
}): string {
  return `${context.workspaceId}\0${context.triggerId}\0${context.secretVersionId}`;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
