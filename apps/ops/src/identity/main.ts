import {
  StartupSettingError,
  describeProcessFailure,
} from '@pertexo/observability/startup';
import { fileURLToPath } from 'node:url';
import { createTwoFactorRecoveryStore } from '@pertexo/core/identity';
import { parseTwoFactorRecoveryConfig } from './two-factor-recovery-config.js';
import { disableTwoFactor } from './disable-two-factor.js';
import { reportProcessFailure } from '../process-failure.js';

const DATABASE_FAILURE =
  'Database access failed. Check DATABASE_URL is reachable and the application role has access, then retry the recovery command.';

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
  void runTwoFactorRecovery().catch((error: unknown) => {
    // A driver's error may carry the account's address, so only a refused
    // setting is described; anything else is the database.
    reportProcessFailure(
      'two_factor_recovery.process_failed',
      error,
      error instanceof StartupSettingError
        ? describeProcessFailure(error)
        : DATABASE_FAILURE,
    );
  });
}
