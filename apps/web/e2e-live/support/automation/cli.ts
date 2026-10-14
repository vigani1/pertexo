import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const entrypoint = fileURLToPath(
  new URL('../../../../cli/dist/main.js', import.meta.url),
);

/** Check the compiled dependency closure before opening any live credential receipt. */
export async function verifyAutomationCliBuild() {
  try {
    const result = await execute(
      process.execPath,
      [entrypoint, 'automation', '--help'],
      { env: {}, timeout: 5_000, maxBuffer: 64 * 1024 },
    );
    if (!result.stdout.startsWith('Pertexo automation') || result.stderr !== '')
      throw new Error('Invalid CLI build');
  } catch {
    throw new Error(
      'Build apps/cli and its dependencies before the owned automation browser journey.',
    );
  }
}

/** Environment-only credential; neither subprocess command nor failure includes it. */
export async function automationCli(
  origin: string,
  credential: string,
  args: string[],
) {
  try {
    const result = await execute(
      process.execPath,
      [entrypoint, 'automation', ...args],
      {
        env: { PERTEXO_API_URL: origin, PERTEXO_API_TOKEN: credential },
        timeout: 35_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (result.stderr !== '')
      throw new Error('Unexpected automation diagnostic');
    return { code: 0, body: JSON.parse(result.stdout) as unknown };
  } catch (cause) {
    if (
      typeof cause === 'object' &&
      cause !== null &&
      'code' in cause &&
      cause.code === 1 &&
      'stdout' in cause &&
      cause.stdout === '' &&
      'stderr' in cause &&
      typeof cause.stderr === 'string'
    ) {
      return { code: 1, body: JSON.parse(cause.stderr) as unknown };
    }
    throw new Error(
      'Owned automation process failed; sensitive details omitted.',
    );
  }
}
