import {
  StartupSettingError,
  describeProcessFailure,
} from '@pertexo/observability/startup';
import { fileURLToPath } from 'node:url';
import { createTwoFactorRecoveryStore } from '@pertexo/core/identity';
import { parseTwoFactorRecoveryConfig } from './two-factor-recovery-config.js';
import { disableTwoFactor } from './disable-two-factor.js';

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
    const detail =
      error instanceof StartupSettingError
        ? describeProcessFailure(error)
        : 'Database access failed. Check DATABASE_URL is reachable and the application role has access, then retry the recovery command.';
    process.stderr.write(`Two-factor recovery failed: ${detail}\n`);
    process.exitCode = 1;
  });
}
