import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  collectRuntimeWorkspaces,
  expectedCommands,
  validateRuntimeClosure,
} from './validate-runtime-closure.mjs';

const root = resolve(import.meta.dirname, '../..');
async function workspaceManifests() {
  const directories = [
    ...(await readdir(resolve(root, 'apps'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => `apps/${entry.name}`),
    ...(await readdir(resolve(root, 'packages'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => `packages/${entry.name}`),
  ];
  const workspaces = new Map();
  for (const directory of directories) {
    const packageManifest = JSON.parse(
      await readFile(resolve(root, directory, 'package.json'), 'utf8'),
    );
    workspaces.set(packageManifest.name, { directory, packageManifest });
  }
  return workspaces;
}

async function fixtures() {
  const [dockerfile, workspaceByName] = await Promise.all([
    readFile(resolve(root, 'Dockerfile'), 'utf8'),
    workspaceManifests(),
  ]);
  const runtimeWorkspaces = collectRuntimeWorkspaces(
    expectedCommands,
    workspaceByName,
  );
  return { dockerfile, runtimeWorkspaces };
}

test('the runtime closure includes every role and its application dependencies', async () => {
  const { dockerfile, runtimeWorkspaces } = await fixtures();

  for (const role of expectedCommands.keys()) {
    const packageName =
      role === 'migration' ? '@pertexo/database' : `@pertexo/${role}`;
    assert.ok(runtimeWorkspaces.has(packageName), `missing ${packageName}`);
  }
  assert.ok(
    runtimeWorkspaces.has('@pertexo/node-catalog'),
    'missing app-only workspace dependency',
  );
  assert.doesNotThrow(() =>
    validateRuntimeClosure(dockerfile, runtimeWorkspaces),
  );
});

for (const role of expectedCommands.keys()) {
  test(`missing ${role} output fails runtime closure validation`, async () => {
    const { dockerfile, runtimeWorkspaces } = await fixtures();
    const packageName =
      role === 'migration' ? '@pertexo/database' : `@pertexo/${role}`;
    const workspace = runtimeWorkspaces.get(packageName);
    const expectedCopy = `/workspace/${workspace.directory}/dist ./${workspace.directory}/dist`;
    const incompleteDockerfile = dockerfile
      .split('\n')
      .filter((line) => !line.includes(expectedCopy))
      .join('\n');

    assert.throws(
      () => validateRuntimeClosure(incompleteDockerfile, runtimeWorkspaces),
      new RegExp(`missing built workspace dependency ${packageName}`),
    );
  });
}

test('missing app-only dependency output fails runtime closure validation', async () => {
  const { dockerfile, runtimeWorkspaces } = await fixtures();
  const workspace = runtimeWorkspaces.get('@pertexo/node-catalog');
  const expectedCopy = `/workspace/${workspace.directory}/dist ./${workspace.directory}/dist`;
  const incompleteDockerfile = dockerfile
    .split('\n')
    .filter((line) => !line.includes(expectedCopy))
    .join('\n');

  assert.throws(
    () => validateRuntimeClosure(incompleteDockerfile, runtimeWorkspaces),
    /missing built workspace dependency @pertexo\/node-catalog/u,
  );
});
