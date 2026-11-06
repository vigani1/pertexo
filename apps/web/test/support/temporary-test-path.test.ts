// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

it('removes per-test files after success, failure and late afterEach diagnostics', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'pertexo-temporary-path-proof-'),
  );
  const paths = join(directory, 'paths.jsonl');
  try {
    const config = join(directory, 'playwright.config.mjs');
    await writeFile(
      config,
      `export default { testDir: ${JSON.stringify(directory)}, testMatch: '*.probe.ts', workers: 1, reporter: 'line', outputDir: ${JSON.stringify(join(directory, 'results'))} };`,
    );
    await writeFile(
      join(directory, 'cleanup.probe.ts'),
      `import { test, temporaryTestPath } from ${JSON.stringify(fileURLToPath(new URL('./temporary-test-path.ts', import.meta.url)))};
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
test.afterEach(() => writeFileSync(temporaryTestPath('late-diagnostic.png'), 'late'));
for (const outcome of ['passes', 'fails']) {
  test(outcome, () => {
    const file = temporaryTestPath('nested/image.png');
    writeFileSync(file, 'owned');
    if (!existsSync(file)) throw new Error('Temporary image missing during test');
    appendFileSync(${JSON.stringify(paths)}, JSON.stringify(file) + '\\n');
    if (outcome === 'fails') throw new Error('Expected cleanup probe failure');
  });
}
`,
    );
    const result = await run(
      process.execPath,
      [
        join(require.resolve('@playwright/test/package.json'), '..', 'cli.js'),
        'test',
        '--config',
        config,
      ],
      { timeout: 15_000 },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(result).toMatchObject({ code: 1 });
    const files = (await readFile(paths, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string);
    expect(files).toHaveLength(2);
    expect(new Set(files).size).toBe(2);
    for (const file of files)
      expect(existsSync(join(file, '..', '..'))).toBe(false);
  } finally {
    // A failed cleanup regression must remove its own probe's files too.
    const recorded = await readFile(paths, 'utf8').catch(() => '');
    for (const line of recorded.trim().split('\n').filter(Boolean))
      await rm(join(JSON.parse(line) as string, '..', '..'), {
        recursive: true,
        force: true,
      });
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
