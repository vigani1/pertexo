/** Test-only shared key wrapping; never an application/package export. */
export function createEditorBrowserEnvelopeKeys<Context extends object>(
  masterKey: Uint8Array,
  purpose: 'connection' | 'webhook',
): {
  generateDataKey(
    context: Context,
    signal?: AbortSignal,
  ): Promise<{
    plaintextKey: Uint8Array;
    encryptedDataKey: Uint8Array;
    keyReference: string;
  }>;
  decryptDataKey(
    wrapped: Uint8Array,
    reference: string,
    context: Context,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  close(): void;
};
