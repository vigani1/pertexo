import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** How long the child process may run. */
const IN_PROCESS_TIMEOUT_MILLIS = 20_000;
/**
 * A test that waits on a child outlasts it, so a slow child fails with its
 * own timeout, not the test runner's.
 */
export const IN_PROCESS_TEST_TIMEOUT_MILLIS = IN_PROCESS_TIMEOUT_MILLIS + 5_000;
const packageDirectory = fileURLToPath(new URL('../..', import.meta.url));

/** Runs in its own process, by package name, so only the built output can answer. */
export async function inProcess(script: string, environment = {}) {
  const { stdout } = await execute(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: packageDirectory,
      env: { ...process.env, ...environment },
      timeout: IN_PROCESS_TIMEOUT_MILLIS,
    },
  );
  return JSON.parse(stdout) as unknown;
}
