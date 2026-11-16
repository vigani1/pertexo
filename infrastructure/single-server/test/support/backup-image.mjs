import { execFileSync } from 'node:child_process';

export const IMAGE_PULL_TIMEOUT_MS = 300_000;

// Read from the backup compose file so tests never name a second copy of the
// pinned digest.
export const backupImage = execFileSync(
  'docker',
  [
    'compose',
    '-f',
    'infrastructure/single-server/backup/compose.yaml',
    'config',
    '--images',
  ],
  { encoding: 'utf8' },
).trim();

/**
 * Downloads an image before a test times the helper that runs it. On a runner
 * without the image cached, the download would otherwise count against the
 * helper's startup window and fail a test whose helper is fine.
 */
export function pullImage(image) {
  execFileSync('docker', ['pull', '--quiet', image], {
    stdio: 'pipe',
    timeout: IMAGE_PULL_TIMEOUT_MS,
  });
}
