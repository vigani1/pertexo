import type { Pool } from 'pg';
import { withArtifactErasure } from './backup-deletion-lock.repository.js';
import { withDeadline } from '../retention/transaction.js';

type ArtifactTarget = Readonly<{
  artifactId: string;
  signal?: AbortSignal;
  workspaceId: string;
}>;

/** Where expired artifacts' bytes are erased. */
export type RetentionArtifactStore = Readonly<{
  delete(input: ArtifactTarget): Promise<void>;
  head(input: ArtifactTarget): Promise<object | null>;
}>;

/**
 * Erases one artifact's bytes, outside any transaction. False means the store
 * still has them, so the caller comes back later and keeps the row until then.
 */
export async function eraseArtifact(
  pool: Pool,
  store: RetentionArtifactStore,
  target: Readonly<{ artifactId: string; workspaceId: string }>,
  { signal, timeoutMs }: Readonly<{ signal?: AbortSignal; timeoutMs: number }>,
): Promise<boolean> {
  const external = { ...target, signal: withDeadline(signal, timeoutMs) };
  return (
    (await withArtifactErasure(pool, async () => {
      external.signal.throwIfAborted();
      await store.delete(external);
      return (await store.head(external)) === null;
    })) ?? false
  );
}
