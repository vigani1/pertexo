import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';

// pnpm is the outside process boundary; exercise the real runner without browsers.
test('a selected mocked job passes only its selected spec to Playwright', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pertexo-mocked-runner-'));
  const capture = join(directory, 'arguments.json');
  try {
    writeFileSync(
      join(directory, 'pnpm'),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.CI_D_RUNNER_CAPTURE, JSON.stringify(process.argv.slice(2)));\n`,
      { mode: 0o755 },
    );
    const result = spawnSync(
      process.execPath,
      ['infrastructure/testing/run-mocked-shard.mjs', '1/1'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${directory}${delimiter}${process.env.PATH}`,
          CI_D_RUNNER_CAPTURE: capture,
          BROWSER_SPECS: JSON.stringify(['e2e/usage.spec.ts']),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).files, ['e2e/usage.spec.ts']);
    const argumentsPassed = JSON.parse(readFileSync(capture, 'utf8'));
    assert.deepEqual(
      argumentsPassed.filter((argument) => argument.startsWith('e2e/')),
      ['e2e/usage\\.spec\\.ts$'],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
