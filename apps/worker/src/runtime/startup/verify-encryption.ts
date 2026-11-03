import {
  createEncryptionKeyRepository,
  verifySystemMailKeys,
} from '@pertexo/secrets/server';
import { verifyStoredEncryptionKeys } from '@pertexo/integrations/server';
import type { WorkerConfig } from '../../config/worker.js';

export async function verifyWorkerEncryption(
  config: WorkerConfig,
  createRepository: typeof createEncryptionKeyRepository = createEncryptionKeyRepository,
  onUnavailableMailKey: (version: string) => void = () => undefined,
): Promise<void> {
  const mail = config.systemMailDelivery;
  if (mail !== undefined)
    await verifySystemMailKeys(
      config.retention.maintenanceDatabase,
      [
        mail.encryption.current.version,
        ...mail.encryption.previous.map((key) => key.version),
      ],
      onUnavailableMailKey,
    );
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
