import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Keep every invocation on the same config and project-discovery adapter.
const result = spawnSync(
  'pnpm',
  [
    'exec',
    'oxlint',
    '-c',
    'oxlint.config.mjs',
    '--report-unused-disable-directives-severity',
    'warn',
    ...process.argv.slice(2),
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      OXLINT_TSGOLINT_PATH: fileURLToPath(
        new URL('./tsgolint-projects.mjs', import.meta.url),
      ),
    },
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
