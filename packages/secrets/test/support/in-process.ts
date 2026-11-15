import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const packageDirectory = fileURLToPath(new URL('../..', import.meta.url));

/** Runs in its own process, by package name, so only the built output can answer. */
export async function inProcess(script: string, environment = {}) {
  const { stdout } = await execute(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: packageDirectory,
      env: { ...process.env, ...environment },
      timeout: 20_000,
    },
  );
  return JSON.parse(stdout) as unknown;
}
