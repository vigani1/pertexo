import { createDatabasePreviewAttemptRunStore } from '@pertexo/core/previews';
import type { DatabaseConfig } from '@pertexo/database/testing';
import { createPlatformNodeRegistry } from '@pertexo/node-catalog/server';
import type { NodeAttemptRuntimeOptions } from '../../../src/attempts/delivery/runtime.js';
import { createPlatformPreviewNodeInvoker } from '../../../src/previews/runtime.js';

/** The shared attempt runtime takes ownership of these existing preview ports. */
export async function createEditorPreview(
  database: DatabaseConfig,
  registry = createPlatformNodeRegistry(),
): Promise<NonNullable<NodeAttemptRuntimeOptions['preview']>> {
  const runStore = createDatabasePreviewAttemptRunStore(database);
  try {
    return {
      runStore,
      invoker: createPlatformPreviewNodeInvoker({
        registry,
      }),
    };
  } catch (error) {
    const failures: unknown[] = [error];
    await runStore.close().catch((failure: unknown) => failures.push(failure));
    if (failures.length === 1) throw error;
    throw new AggregateError(
      failures,
      'Owned preview construction and cleanup failed',
    );
  }
}
