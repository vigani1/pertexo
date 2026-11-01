import { createEncryptionKeyRepository } from '@pertexo/secrets/server';
import { verifyStoredEncryptionKeys } from '@pertexo/integrations/server';
import type { WorkerConfig } from '../../config/worker.js';

export async function verifyWorkerEncryption(
  config: WorkerConfig,
  createRepository: typeof createEncryptionKeyRepository = createEncryptionKeyRepository,
): Promise<void> {
  if (config.connectionEncryption === undefined) return;
  const repository = createRepository(config.retention.maintenanceDatabase);
  try {
    const signal = AbortSignal.timeout(120_000);
    await verifyStoredEncryptionKeys(
      config.connectionEncryption,
      repository.read(signal),
      signal,
    );
  } catch (error: unknown) {
    try {
      await repository.close();
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [error, cleanupError],
        'Startup encryption verification and cleanup failed',
      );
    }
    throw error;
  }
  await repository.close();
}
