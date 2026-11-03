import { callbackTokenHash, type CallbackTokenKeys } from './keys.js';
/** Probes contain only opaque record IDs, versions and hashes, never tenant data. */
export async function verifyCallbackTokenKeys(
  keys: CallbackTokenKeys | undefined,
  probes: AsyncIterable<
    Readonly<{ id: string; keyVersion: string; tokenHash: string }>
  >,
  signal: AbortSignal,
): Promise<void> {
  for await (const probe of probes) {
    signal.throwIfAborted();
    if (keys === undefined)
      throw new Error(
        'Retained callback credentials require CALLBACK_TOKEN_KEY and their previous key versions.',
      );
    if (
      callbackTokenHash(keys.material(probe, probe.keyVersion).token) !==
      probe.tokenHash
    )
      throw new Error(
        'The configured callback key does not match retained callbacks. Restore the original CALLBACK_TOKEN_KEY or previous version before starting.',
      );
  }
}
