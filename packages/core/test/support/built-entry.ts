import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Imports a package entry the way a process does, from the built package: a
 * broken `exports` map or a missing file shows here, where a test importing
 * `src` can't see it.
 */
export async function loadBuiltEntry(entry: string): Promise<string[]> {
  const { stdout } = await run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const loaded = await import(${JSON.stringify(entry)});
       process.stdout.write(JSON.stringify(Object.keys(loaded).sort()));`,
    ],
    { cwd: new URL('../..', import.meta.url), timeout: 60_000 },
  );
  return JSON.parse(stdout) as string[];
}
