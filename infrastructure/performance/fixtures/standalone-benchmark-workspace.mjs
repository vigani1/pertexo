import { execFile } from 'node:child_process';
import {
  copyFile,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { isolatedGitEnvironment } from '../../support/git-environment.mjs';

const executeFile = promisify(execFile);
const sourceRoot = path.resolve(import.meta.dirname, '../../..');
const copiedModules = Object.freeze([
  'infrastructure/performance/run-local-benchmark.mjs',
  'infrastructure/performance/postgres-evidence.mjs',
  'infrastructure/performance/compare-local-benchmark.mjs',
  'infrastructure/support/owned-process-tree.mjs',
  'infrastructure/support/git-environment.mjs',
]);
const fixtureSource =
  "export const fixtureBuildSource = 'owned fixture source';\n";
const builtFixturePrefix = '// compiled from the owned fixture source\n';

async function runGit(root, args) {
  await executeFile('git', ['-C', root, ...args], {
    env: isolatedGitEnvironment(),
  });
}

async function settleSetupOperations(operations, description) {
  const results = await Promise.allSettled(operations);
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, description);
}

export async function createStandaloneBenchmarkWorkspace(parentDirectory) {
  const root = path.join(
    await realpath(parentDirectory),
    'standalone-benchmark-workspace',
  );
  const runnerPath = path.join(
    root,
    'infrastructure/performance/run-local-benchmark.mjs',
  );
  const sourcePath = path.join(root, 'packages/database/src/fixture.mjs');
  const compiledOutputPath = path.join(
    root,
    'packages/database/dist/fixture.mjs',
  );
  try {
    await settleSetupOperations(
      [
        mkdir(path.join(root, 'apps'), { recursive: true }),
        mkdir(path.dirname(sourcePath), { recursive: true }),
        mkdir(path.join(root, 'infrastructure/performance/fixtures'), {
          recursive: true,
        }),
        mkdir(path.join(root, 'infrastructure/support'), { recursive: true }),
      ],
      'Cannot create standalone benchmark fixture directories',
    );
    await settleSetupOperations(
      copiedModules.map(async (relative) => {
        const destination = path.join(root, relative);
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(path.join(sourceRoot, relative), destination);
      }),
      'Cannot copy standalone benchmark fixture modules',
    );
    const buildScriptPath = path.join(
      root,
      'infrastructure/performance/fixtures/build-owned-output.mjs',
    );
    await settleSetupOperations(
      [
        writeFile(
          path.join(root, 'package.json'),
          `${JSON.stringify(
            {
              name: 'pertexo-standalone-benchmark-fixture',
              private: true,
              type: 'module',
              packageManager: 'pnpm@11.22.0',
              scripts: {
                build:
                  'node infrastructure/performance/fixtures/build-owned-output.mjs',
              },
            },
            null,
            2,
          )}\n`,
        ),
        writeFile(
          path.join(root, 'packages/database/package.json'),
          `${JSON.stringify(
            {
              name: '@pertexo/database-fixture',
              private: true,
              type: 'module',
            },
            null,
            2,
          )}\n`,
        ),
        writeFile(sourcePath, fixtureSource),
        writeFile(
          path.join(root, '.gitignore'),
          'apps/*/dist/\npackages/*/dist/\nnode_modules/\npnpm-lock.yaml\n',
        ),
        writeFile(
          buildScriptPath,
          `import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../..');
const source = path.join(root, 'packages/database/src/fixture.mjs');
const output = path.join(root, 'packages/database/dist/fixture.mjs');
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, ${JSON.stringify(builtFixturePrefix)} + (await readFile(source, 'utf8')));
`,
        ),
      ],
      'Cannot write standalone benchmark fixture sources',
    );
    await executeFile(
      'git',
      ['init', '--quiet', '--initial-branch=fixture', root],
      { env: isolatedGitEnvironment() },
    );
    await runGit(root, ['config', 'user.name', 'Pertexo Fixture']);
    await runGit(root, ['config', 'user.email', 'fixture@pertexo.invalid']);
    await runGit(root, ['add', '.']);
    await runGit(root, [
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--quiet',
      '-m',
      'Initialize standalone benchmark fixture',
    ]);
    return Object.freeze({
      root,
      runnerPath,
      compiledOutputPath,
      sourcePath,
      gitDirectory: path.join(root, '.git'),
      expectedCompiledOutput: `${builtFixturePrefix}${fixtureSource}`,
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function readProductionBenchmarkRunner() {
  return readFile(
    path.join(sourceRoot, 'infrastructure/performance/run-local-benchmark.mjs'),
    'utf8',
  );
}
