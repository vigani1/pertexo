import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const execFileAsync = promisify(execFile);

describe('contracts browser entry', () => {
  it('reaches no Node module, so the web can import it', async () => {
    await expect(
      execFileAsync(process.execPath, [
        resolve(
          repositoryRoot,
          'infrastructure/checks/browser-entry-dependencies.mjs',
        ),
        '--root',
        repositoryRoot,
        'packages/contracts/src/index.ts',
      ]),
    ).resolves.toMatchObject({ stderr: '' });
  });
});
