import {
  createEncryptionKeyRepository,
  parseMaintenanceDatabaseConfig,
} from '../../../packages/database/dist/platform/index.js';
import {
  parseConnectionEncryptionConfig,
  verifyStoredEncryptionKeys,
  StoredKeyVerificationError,
} from '../../../packages/integrations/dist/server.js';
import { createCallbackStore } from '../../../packages/core/dist/runs/index.js';
import { parseDatabaseConfig } from '../../../packages/database/dist/config.js';
import {
  parseCallbackKeyConfig,
  createCallbackTokenKeys,
  verifyCallbackTokenKeys,
} from '../../../packages/integrations/dist/server.js';
import { requireCompatibleRelease } from './require-compatible-release.mjs';

const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
let repository;
let callbacks;
let callbackKeys;
let verifyingCallbacks = false;
try {
  const environment = process.env;
  const config = parseConnectionEncryptionConfig(
    environment,
    environment.NODE_ENV === 'staging' || environment.NODE_ENV === 'production',
  );
  if (config === undefined)
    throw new Error('Encryption configuration is required');
  requireCompatibleRelease(config, process.argv[2]);
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
  verifyingCallbacks = true;
  const callbackConfig = parseCallbackKeyConfig(
    environment,
    environment.NODE_ENV === 'staging' || environment.NODE_ENV === 'production',
  );
  callbackKeys =
    callbackConfig === undefined
      ? undefined
      : createCallbackTokenKeys(callbackConfig);
  callbacks = createCallbackStore(
    parseDatabaseConfig({ connectionString: environment.DATABASE_URL, max: 1 }),
  );
  await verifyCallbackTokenKeys(
    callbackKeys,
    callbacks.keysInUse(signal),
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
      code: verifyingCallbacks
        ? 'callback_key_unavailable'
        : error instanceof StoredKeyVerificationError
          ? error.code
          : 'configuration_or_database_invalid',
      detail: verifyingCallbacks
        ? 'Callback key verification failed; restore CALLBACK_TOKEN_KEY and all required CALLBACK_TOKEN_PREVIOUS_KEYS separately.'
        : error instanceof StoredKeyVerificationError
          ? error.message
          : 'Encryption configuration or database access is invalid',
    }) + '\n',
  );
  process.exitCode = 1;
} finally {
  try {
    callbackKeys?.close();
    const cleanup = await Promise.allSettled([
      repository?.close(),
      callbacks?.close(),
    ]);
    if (cleanup.some((item) => item.status === 'rejected')) {
      process.stderr.write(
        JSON.stringify({ event: 'encryption.cleanup_failed' }) + '\n',
      );
      process.exitCode = 1;
    }
  } catch {
    process.stderr.write(
      JSON.stringify({ event: 'encryption.cleanup_failed' }) + '\n',
    );
    process.exitCode = 1;
  }
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
