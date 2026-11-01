import { fileURLToPath } from 'node:url';
import { createTwoFactorRecoveryStore } from '@pertexo/core/identity';
import { parseTwoFactorRecoveryConfig } from './config.js';
import { disableTwoFactor } from './run.js';

export async function runTwoFactorRecovery(): Promise<void> {
  const config = parseTwoFactorRecoveryConfig();
  const store = createTwoFactorRecoveryStore(config.database);
  try {
    const result = await disableTwoFactor(config, store);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === 'not_found') process.exitCode = 1;
  } finally {
    await store.close();
  }
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  void runTwoFactorRecovery().catch(() => {
    // Configuration and database errors may contain credentials; print no exception payload.
    process.stderr.write(
      'Two-factor recovery failed. Check the command arguments, application database access and authentication-mail configuration.\n',
    );
    process.exitCode = 1;
  });
}
