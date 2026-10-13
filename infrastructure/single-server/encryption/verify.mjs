import {
  createEncryptionKeyRepository,
  parseMaintenanceDatabaseConfig,
} from '../../../packages/database/dist/platform/index.js';
import {
  parseConnectionEncryptionConfig,
  verifyStoredEncryptionKeys,
  StoredKeyVerificationError,
} from '../../../packages/integrations/dist/server.js';

const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
let repository;
try {
  const environment = process.env;
  const config = parseConnectionEncryptionConfig(
    environment,
    environment.NODE_ENV === 'staging' || environment.NODE_ENV === 'production',
  );
  if (config === undefined)
    throw new Error('Encryption configuration is required');
  repository = createEncryptionKeyRepository(
    parseMaintenanceDatabaseConfig(environment),
  );
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(120_000),
  ]);
  const result = await verifyStoredEncryptionKeys(
    config,
    repository.read(signal),
    signal,
  );
  process.stdout.write(
    JSON.stringify({
      event: 'encryption.verified',
      mode: 'mode' in config ? config.mode : 'kms',
      ...result,
    }) + '\n',
  );
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      event: 'encryption.verification_failed',
      code:
        error instanceof StoredKeyVerificationError
          ? error.code
          : 'configuration_or_database_invalid',
      detail:
        error instanceof StoredKeyVerificationError
          ? error.message
          : 'Encryption configuration or database access is invalid',
    }) + '\n',
  );
  process.exitCode = 1;
} finally {
  try {
    await repository?.close();
  } catch {
    process.stderr.write(
      JSON.stringify({ event: 'encryption.cleanup_failed' }) + '\n',
    );
    process.exitCode = 1;
  }
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
