import { spawnSync } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

export const BUILT_PACKAGE_CONSUMER_CASES = Object.freeze([
  { packageDirectory: 'packages/contracts', specifier: '@pertexo/contracts' },
  {
    conditions: ['browser'],
    packageDirectory: 'packages/contracts',
    specifier: '@pertexo/contracts/workflow-runs',
  },
  {
    conditions: ['browser'],
    packageDirectory: 'packages/node-sdk',
    specifier: '@pertexo/node-sdk',
  },
  {
    conditions: ['browser'],
    packageDirectory: 'packages/node-sdk',
    specifier: '@pertexo/node-sdk/release',
  },
  {
    conditions: ['browser'],
    expected: 'browser-rejected',
    packageDirectory: 'packages/node-sdk',
    specifier: '@pertexo/node-sdk/server',
  },
  {
    conditions: ['browser'],
    packageDirectory: 'packages/nodes-core',
    specifier: '@pertexo/nodes-core',
  },
  {
    conditions: ['browser'],
    expected: 'browser-rejected',
    packageDirectory: 'packages/nodes-core',
    specifier: '@pertexo/nodes-core/server',
  },
  {
    conditions: ['browser'],
    packageDirectory: 'packages/node-catalog',
    specifier: '@pertexo/node-catalog',
  },
  {
    conditions: ['browser'],
    expected: 'browser-rejected',
    packageDirectory: 'packages/node-catalog',
    specifier: '@pertexo/node-catalog/server',
  },
  {
    conditions: ['browser'],
    packageDirectory: 'packages/workflow-model',
    specifier: '@pertexo/workflow-model/graph-contract',
  },
  {
    packageDirectory: 'packages/workflow-model',
    specifier: '@pertexo/workflow-model',
  },
  {
    packageDirectory: 'packages/workflow-engine',
    specifier: '@pertexo/workflow-engine',
  },
  {
    packageDirectory: 'packages/workflow-engine',
    specifier: '@pertexo/workflow-engine/testing',
  },
  {
    conditions: ['browser'],
    expected: 'browser-rejected',
    packageDirectory: 'packages/workflow-engine',
    specifier: '@pertexo/workflow-engine',
  },
]);

function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function importProbe(specifier) {
  return `
const specifier = ${JSON.stringify(specifier)};
try {
  const resolved = import.meta.resolve(specifier);
  const imported = await import(specifier);
  process.stdout.write(JSON.stringify({
    exports: Object.keys(imported).sort(),
    resolved,
  }));
} catch (error) {
  process.stderr.write(JSON.stringify({
    code: typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined,
    name: error instanceof Error ? error.name : typeof error,
  }));
  process.exitCode = 17;
}
`;
}

export async function validateBuiltPackageExports(options = {}) {
  const root = path.resolve(options.root ?? repositoryRoot);
  const cases = options.cases ?? BUILT_PACKAGE_CONSUMER_CASES;
  const failures = [];

  for (const testCase of cases) {
    const packageDirectory = path.resolve(root, testCase.packageDirectory);
    let manifest;
    try {
      manifest = JSON.parse(
        await readFile(path.join(packageDirectory, 'package.json'), 'utf8'),
      );
    } catch (error) {
      failures.push(
        `${testCase.packageDirectory}: cannot read package manifest (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }
    if (manifest.name !== packageName(testCase.specifier)) {
      failures.push(
        `${testCase.packageDirectory}: ${testCase.specifier} is not a self-reference for ${String(manifest.name)}`,
      );
      continue;
    }

    const result = spawnSync(
      process.execPath,
      [
        ...(testCase.conditions ?? []).flatMap((condition) => [
          '--conditions',
          condition,
        ]),
        '--input-type=module',
        '--eval',
        importProbe(testCase.specifier),
      ],
      { cwd: packageDirectory, encoding: 'utf8' },
    );

    if (testCase.expected === 'browser-rejected') {
      let diagnostic;
      try {
        diagnostic = JSON.parse(result.stderr);
      } catch {
        diagnostic = undefined;
      }
      if (
        result.status !== 17 ||
        diagnostic?.code !== 'ERR_INVALID_PACKAGE_TARGET'
      )
        failures.push(
          `${testCase.specifier}: browser condition did not reject the explicit false export target (${result.stderr || result.stdout || `status ${String(result.status)}`})`,
        );
      continue;
    }

    if (result.status !== 0) {
      failures.push(
        `${testCase.specifier}: built consumer import failed (${result.stderr || `status ${String(result.status)}`})`,
      );
      continue;
    }
    let observation;
    try {
      observation = JSON.parse(result.stdout);
    } catch {
      failures.push(
        `${testCase.specifier}: import probe returned invalid JSON`,
      );
      continue;
    }
    const expectedDistPrefix = `${await realpath(packageDirectory)}${path.sep}dist${path.sep}`;
    const resolvedPath = fileURLToPath(observation.resolved);
    if (!resolvedPath.startsWith(expectedDistPrefix))
      failures.push(
        `${testCase.specifier}: resolved outside its built dist directory (${resolvedPath})`,
      );
    if (!Array.isArray(observation.exports) || observation.exports.length === 0)
      failures.push(`${testCase.specifier}: built entry exports no values`);
  }

  return Object.freeze(failures);
}

async function main() {
  const failures = await validateBuiltPackageExports();
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`${failure}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Validated ${String(BUILT_PACKAGE_CONSUMER_CASES.length)} built package consumer cases.\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
