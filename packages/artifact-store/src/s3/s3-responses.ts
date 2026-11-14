import type { Readable } from 'node:stream';

import type { Destroyable } from '../storage/artifact-storage.types.js';

export function isNotFound(error: unknown): boolean {
  try {
    if (typeof error !== 'object' || error === null) {
      return false;
    }

    const candidate = error as {
      readonly $metadata?: { readonly httpStatusCode?: number };
      readonly name?: string;
    };
    return (
      candidate.$metadata?.httpStatusCode === 404 ||
      candidate.name === 'NoSuchKey' ||
      candidate.name === 'NotFound'
    );
  } catch {
    return false;
  }
}

export async function consume(body: Readable): Promise<void> {
  for await (const _chunk of body) {
    // Integrity is enforced by the verifier while bytes are discarded.
  }
}

export function destroyResponseBody(body: unknown): void {
  if (isDestroyable(body)) {
    body.destroy();
  }
}

function isDestroyable(value: unknown): value is Destroyable {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { readonly destroy?: unknown };
  return typeof candidate.destroy === 'function';
}
