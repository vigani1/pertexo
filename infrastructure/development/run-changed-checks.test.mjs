import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  planChangedChecks,
  readWorkspacePackages,
} from './run-changed-checks.mjs';

const packages = [
  {
    name: '@pertexo/contracts',
    directory: 'packages/contracts',
    scripts: { test: 'vitest run', typecheck: 'tsc' },
    dependencies: [],
  },
  {
    name: '@pertexo/api',
    directory: 'apps/api',
    scripts: { test: 'vitest run', typecheck: 'tsc' },
    dependencies: ['@pertexo/contracts'],
  },
  {
    name: '@pertexo/web',
    directory: 'apps/web',
    scripts: { test: 'vitest run', typecheck: 'tsc' },
    dependencies: ['@pertexo/contracts'],
  },
];

const labels = (commands) => commands.map((command) => command.label);

test('lints and tests only the changed package, and typechecks its dependents', () => {
  const commands = planChangedChecks(
    ['packages/contracts/src/http/workspace-inbox.ts'],
    packages,
  );
  assert.deepEqual(labels(commands), [
    'lint @pertexo/contracts',
    'related unit tests @pertexo/contracts',
    'typecheck @pertexo/api',
    'typecheck @pertexo/contracts',
    'typecheck @pertexo/web',
  ]);
  const related = commands.find(
    (command) => command.label === 'related unit tests @pertexo/contracts',
  );
  assert.equal(related.cwd, 'packages/contracts');
  assert.deepEqual(related.command.slice(0, 5), [
    'pnpm',
    'exec',
    'vitest',
    'related',
    '--run',
  ]);
  assert.ok(related.command.includes('**/*.integration.test.ts'));
  assert.equal(
    commands.find((command) => command.label === 'lint @pertexo/contracts')
      ?.environment?.NODE_OPTIONS,
    '--max-old-space-size=8192',
  );
  assert.equal(related.command.at(-1), 'src/http/workspace-inbox.ts');
});

test('typechecks packages that depend on the change through another package', () => {
  const commands = planChangedChecks(
    ['packages/workflow-model/src/graph.ts'],
    [
      ...packages,
      {
        name: '@pertexo/workflow-model',
        directory: 'packages/workflow-model',
        scripts: { typecheck: 'tsc' },
        dependencies: [],
      },
      {
        name: '@pertexo/workflow-engine',
        directory: 'packages/workflow-engine',
        scripts: { typecheck: 'tsc' },
        dependencies: ['@pertexo/workflow-model'],
      },
      {
        name: '@pertexo/worker',
        directory: 'apps/worker',
        scripts: { typecheck: 'tsc' },
        dependencies: ['@pertexo/workflow-engine'],
      },
    ],
  );
  assert.deepEqual(labels(commands), [
    'lint @pertexo/workflow-model',
    'typecheck @pertexo/worker',
    'typecheck @pertexo/workflow-engine',
    'typecheck @pertexo/workflow-model',
  ]);
});

test('skips lint and tests for files they cannot check', () => {
  const commands = planChangedChecks(
    ['apps/web/README.md', 'apps/api/src/types.d.ts'],
    packages,
  );
  assert.deepEqual(labels(commands), [
    'lint @pertexo/api',
    'typecheck @pertexo/api',
    'typecheck @pertexo/web',
  ]);
});

test('ignores documentation outside packages', () => {
  assert.deepEqual(
    planChangedChecks(['docs/product-roadmap.md', 'README.md'], packages),
    [],
  );
});

test('lints changed infrastructure scripts and runs their existing node tests', () => {
  const existing = new Set([
    'infrastructure/checks/validate-ci-gates.test.mjs',
  ]);
  const commands = planChangedChecks(
    [
      'infrastructure/checks/validate-ci-gates.mjs',
      'infrastructure/checks/validate-image-pins.mjs',
    ],
    packages,
    (file) => existing.has(file),
  );
  assert.deepEqual(labels(commands), [
    'lint infrastructure',
    'infrastructure node tests',
  ]);
  assert.equal(
    commands[0].environment?.NODE_OPTIONS,
    '--max-old-space-size=8192',
  );
  assert.deepEqual(commands[1].command, [
    'node',
    '--test',
    'infrastructure/checks/validate-ci-gates.test.mjs',
  ]);
});

test('reads every workspace package with its workspace dependencies', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const workspace = readWorkspacePackages(root);
  const api = workspace.find((entry) => entry.name === '@pertexo/api');
  assert.equal(api?.directory, 'apps/api');
  assert.ok(api?.dependencies.includes('@pertexo/contracts'));
  assert.ok(workspace.every((entry) => entry.name.startsWith('@pertexo/')));
});
