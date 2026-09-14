import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  describeBoundedChildFailure,
  runBoundedChildProcess,
} from '../support/bounded-child-process.mjs';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
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
    packageDirectory: 'packages/observability',
    specifier: '@pertexo/observability/process-error-classification',
  },
  {
    forbiddenExports: ['createConnectionDatabase', 'createCoordinatorRunStore'],
    packageDirectory: 'packages/database',
    requireTypes: true,
    requiredExports: ['createApiConnectionDatabase', 'createDatabaseRuntime'],
    specifier: '@pertexo/database/api',
  },
  {
    forbiddenExports: [
      'createApiConnectionDatabase',
      'createIdentityWorkspaceDatabase',
    ],
    packageDirectory: 'packages/database',
    requireTypes: true,
    requiredExports: [
      'acquireDatabasePool',
      'createCoordinatorRunStore',
      'createWorkerConnectionResolutionDatabase',
    ],
    specifier: '@pertexo/database/execution',
  },
  {
    forbiddenExports: ['createCoordinatorRunStore'],
    packageDirectory: 'packages/database',
    requireTypes: true,
    requiredExports: ['createWorkspaceLifecycleCommandCoordinator'],
    specifier: '@pertexo/database/lifecycle',
  },
  {
    forbiddenExports: ['createControlLedgerCoordinator'],
    packageDirectory: 'packages/database',
    requireTypes: true,
    requiredExports: [
      'createDatabaseRuntime',
      'createWorkspacePurgeCoordinator',
    ],
    specifier: '@pertexo/database/maintenance',
  },
  {
    forbiddenExports: ['createConnectionDatabase'],
    packageDirectory: 'packages/database',
    requireTypes: true,
    requiredExports: ['createOperatorCommandDatabase'],
    specifier: '@pertexo/database/operator',
  },
  {
    forbiddenExports: ['createWorkspaceLifecycleCommandCoordinator'],
    packageDirectory: 'packages/database',
    requireTypes: true,
    requiredExports: ['createControlLedgerCoordinator'],
    specifier: '@pertexo/database/recovery',
  },
  {
    packageDirectory: 'packages/database',
    requireTypes: true,
    requiredExports: ['createConnectionDatabase', 'migrateDatabase'],
    specifier: '@pertexo/database/testing',
  },
  {
    expected: 'resolution-rejected',
    expectedErrorCodes: ['ERR_PACKAGE_PATH_NOT_EXPORTED'],
    packageDirectory: 'packages/database',
    specifier: '@pertexo/database',
  },
  {
    expected: 'resolution-rejected',
    expectedErrorCodes: ['ERR_PACKAGE_PATH_NOT_EXPORTED'],
    packageDirectory: 'packages/database',
    specifier: '@pertexo/database/src/config.js',
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
  const importTimeoutMs = options.importTimeoutMs ?? 10_000;

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

    if (testCase.requireTypes === true) {
      const packageSubpath = testCase.specifier.slice(manifest.name.length);
      const exportKey = packageSubpath === '' ? '.' : `.${packageSubpath}`;
      const declarationTarget = manifest.exports?.[exportKey]?.types;
      if (typeof declarationTarget !== 'string') {
        failures.push(
          `${testCase.specifier}: package export has no declaration target`,
        );
        continue;
      }
      try {
        const declarationPath = await realpath(
          path.resolve(packageDirectory, declarationTarget),
        );
        const expectedDistPrefix = `${await realpath(packageDirectory)}${path.sep}dist${path.sep}`;
        if (!declarationPath.startsWith(expectedDistPrefix))
          failures.push(
            `${testCase.specifier}: declaration resolved outside its built dist directory (${declarationPath})`,
          );
      } catch (error) {
        failures.push(
          `${testCase.specifier}: built declaration cannot be resolved (${error instanceof Error ? error.message : String(error)})`,
        );
        continue;
      }
    }

    const result = await runBoundedChildProcess(
      options.nodeExecutable ?? process.execPath,
      [
        ...(testCase.conditions ?? []).flatMap((condition) => [
          '--conditions',
          condition,
        ]),
        '--input-type=module',
        '--eval',
        importProbe(testCase.specifier),
      ],
      { cwd: packageDirectory, timeoutMs: importTimeoutMs },
    );

    if (result.spawnError !== undefined || result.timedOut) {
      failures.push(
        `${testCase.specifier}: ${describeBoundedChildFailure('built consumer import', result, importTimeoutMs)}`,
      );
      continue;
    }

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

    if (testCase.expected === 'resolution-rejected') {
      let diagnostic;
      try {
        diagnostic = JSON.parse(result.stderr);
      } catch {
        diagnostic = undefined;
      }
      if (
        result.status !== 17 ||
        !testCase.expectedErrorCodes?.includes(diagnostic?.code)
      )
        failures.push(
          `${testCase.specifier}: package resolution was not rejected as expected (${result.stderr || result.stdout || `status ${String(result.status)}`})`,
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
    if (testCase.expectedResolvedTarget !== undefined) {
      const expectedTarget = await realpath(
        path.resolve(packageDirectory, testCase.expectedResolvedTarget),
      );
      if (resolvedPath !== expectedTarget)
        failures.push(
          `${testCase.specifier}: resolved ${resolvedPath} instead of ${expectedTarget}`,
        );
    }
    if (!Array.isArray(observation.exports) || observation.exports.length === 0)
      failures.push(`${testCase.specifier}: built entry exports no values`);
    for (const requiredExport of testCase.requiredExports ?? [])
      if (!observation.exports.includes(requiredExport))
        failures.push(
          `${testCase.specifier}: built entry is missing ${requiredExport}`,
        );
    for (const forbiddenExport of testCase.forbiddenExports ?? [])
      if (observation.exports.includes(forbiddenExport))
        failures.push(
          `${testCase.specifier}: built entry unexpectedly exports ${forbiddenExport}`,
        );
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
