#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../..');
const payload = JSON.parse(readFileSync(0, 'utf8'));

// The headless backend accepts source_overrides for its whole filesystem,
// including tsconfigs. Give it test programs without changing emitted builds.
// https://github.com/oxc-project/tsgolint/blob/v7.0.2007/cmd/tsgolint/headless.go
payload.source_overrides = {
  ...payload.source_overrides,
  ...projectOverrides(root),
};
const result = spawnSync(
  process.execPath,
  [
    require.resolve('oxlint-tsgolint/bin/tsgolint.js'),
    ...process.argv.slice(2),
  ],
  { input: JSON.stringify(payload), stdio: ['pipe', 'inherit', 'inherit'] },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

function projectOverrides(directory) {
  const overrides = {};
  for (const area of ['apps', 'packages']) {
    for (const entry of readdirSync(resolve(directory, area), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const workspace = resolve(directory, area, entry.name);
      const testConfig = resolve(workspace, 'tsconfig.test.json');
      if (!existsSync(testConfig)) continue;
      const sourceConfig = resolve(workspace, 'tsconfig.json');
      const source = readFileSync(sourceConfig, 'utf8');
      const test = JSON.parse(readFileSync(testConfig, 'utf8'));
      const originalConfig = resolve(workspace, '.tsconfig-source.json');
      overrides[originalConfig] = source;
      // Source files keep the source program; tests and tooling use the test
      // program. Discovery only recognizes the standard tsconfig filename.
      overrides[resolve(workspace, 'src/tsconfig.json')] = JSON.stringify({
        extends: '../.tsconfig-source.json',
      });
      for (const section of ['test', 'e2e', 'e2e-live', 'scripts']) {
        if (!existsSync(resolve(workspace, section))) continue;
        overrides[resolve(workspace, section, 'tsconfig.json')] =
          JSON.stringify({
            extends: '../tsconfig.test.json',
          });
      }
      overrides[testConfig] = JSON.stringify({
        ...test,
        extends: './.tsconfig-source.json',
      });
      overrides[sourceConfig] = JSON.stringify({
        extends: './tsconfig.test.json',
      });
    }
  }
  overrides[resolve(directory, 'tsconfig.json')] = JSON.stringify({
    extends: './tsconfig.base.json',
    compilerOptions: { types: ['node'] },
    include: ['infrastructure/testing/**/*.d.mts'],
  });
  return overrides;
}
