import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inspectFileNames, validateFileName } from './validate-file-names.mjs';

const source = 'packages/example/src';
const browser = 'apps/web/src/features/connections';
const check = (file, text = '') => validateFileName(file, text);
const rules = (file, text = '') => check(file, text).map((error) => error.rule);

for (const file of [
  `${source}/runs/advance/advance-run.ts`,
  `${source}/workflow-graph.schemas.ts`,
  `${source}/draft.ts`,
  `${source}/fields.tsx`,
  `${source}/cursor.ts`,
  `${source}/client.ts`,
  `${source}/input.ts`,
  `${source}/policy.ts`,
  `${source}/server.ts`,
  `${source}/main.ts`,
  `${source}/testing.ts`,
  `${source}/startup.ts`,
  `${source}/schema.ts`,
  `${source}/primitives.ts`,
  `${source}/platform.ts`,
  `${source}/environment.d.ts`,
  `${source}/environment.d.mts`,
  `${source}/tool.config.cts`,
  `${source}/adapter.mjs`,
  `${source}/adapter.cjs`,
  `${source}/view.jsx`,
  'packages/example/test/problem-details.filter/redis-runtime.protocol.test.ts',
  'apps/worker/test/dispatch.resilience/42-recovery.integration.test.ts',
  'apps/web/e2e/connections.spec.ts',
  'apps/web/e2e-live/support/client.js',
  'packages/example/test/fixtures/helpers.ts',
  `${browser}/data/publication-review.api.ts`,
  `${browser}/data/variables.queries.ts`,
  `${browser}/connections-queries.public.ts`,
  `${browser}/connections-search.public.ts`,
  `${browser}/public.ts`,
  `${browser}/picker.public.ts`,
  'apps/api/src/platform/config/api.ts',
]) {
  test(`accepts ${file}`, () => assert.deepEqual(check(file), []));
}

for (const file of [
  `${source}/BadName.ts`,
  `${source}/bad_name.ts`,
  `${source}/bad--name.ts`,
  `${source}/.hidden.ts`,
  `${source}/bad..name.ts`,
  `${source}/Bad-Area/file.ts`,
  `${source}/bad.area/file.ts`,
  'packages/example/test/bad_area/file.test.ts',
]) {
  test(`rejects invalid spelling in ${file}`, () =>
    assert.ok(rules(file).includes('FN001')));
}

test('does not impose production directory spelling on the scanned root ancestors', () => {
  assert.deepEqual(check('packages/Tool_Name/src/client.ts'), []);
});

for (const stem of [
  'contract',
  'types',
  'store',
  'errors',
  'validation',
  'definition',
  'executor',
  'controller',
  'controllers',
  'module',
  'runtime',
  'service',
  'use-case',
  'use-cases',
  'utils',
  'helpers',
  'common',
]) {
  test(`rejects the bare production subject ${stem}`, () => {
    assert.ok(rules(`${source}/${stem}.ts`).includes('FN002'));
    assert.deepEqual(check(`packages/example/test/support/${stem}.ts`), []);
    assert.deepEqual(check(`${source}/workspace-${stem}.ts`), []);
  });
}

test('backend queries use the persistence vocabulary and browser queries remain valid', () => {
  for (const root of [source, 'apps/api/src']) {
    for (const name of ['variables.queries.ts', 'queries.ts'])
      assert.ok(rules(`${root}/${name}`).includes('FN003'));
    assert.deepEqual(check(`${root}/variables.repository.ts`), []);
  }
  assert.deepEqual(check(`${browser}/data/variables.queries.ts`), []);
});

test('browser transport subjects and focused public subjects are explicit', () => {
  for (const name of ['api.ts', 'queries.ts']) {
    assert.ok(rules(`${browser}/data/nested/${name}`).includes('FN004'));
    assert.deepEqual(check(`apps/web/src/lib/${name}`), []);
  }
  for (const name of ['queries.public.ts', 'search.public.ts'])
    assert.ok(rules(`${browser}/nested/${name}`).includes('FN004'));
});

for (const text of [
  '',
  '; // an entry\n',
  "import { value } from './value.js'; export { value };",
  "import type { Value } from './value.js'; export type { Value };",
  "export * from './value.js';",
  "export type {} from './value.js';",
  "export { type Value, value } from './value.js';",
]) {
  test(`accepts a deliberate entry: ${text}`, () =>
    assert.deepEqual(check(`${source}/index.ts`, text), []));
}
for (const text of [
  "import './startup.js';",
  "import {} from './startup.js';",
  'const value = 1; export { value };',
  'export const value = 1;',
  'export function value() {}',
  'export class Value {}',
  'export default 1;',
  'export = value;',
  'start();',
]) {
  test(`rejects an implemented entry: ${text}`, () => {
    for (const extension of ['ts', 'tsx'])
      assert.ok(rules(`${source}/index.${extension}`, text).includes('FN005'));
  });
}

for (const text of [
  'export interface Value { name: string } export type Name = string;',
  "import type Value from './value.js'; export type Name = Value;",
  "import type * as Value from './value.js';",
  "import type Value = require('./value.js');",
  "import { type A, type B } from './value.js';",
  "export type { Value } from './value.js';",
  "export type * from './value.js';",
  "export type {} from './value.js';",
  "export type * as Values from './value.js';",
  "export { type A, type B } from './value.js';",
  'export {};',
]) {
  test(`accepts erased types: ${text}`, () =>
    assert.deepEqual(check(`${source}/value.types.ts`, text), []));
}
for (const text of [
  "import Value from './value.js';",
  "import './value.js';",
  "import {} from './value.js';",
  "import { type A, B } from './value.js';",
  "import Value, { type A } from './value.js';",
  "import Value = require('./value.js');",
  "export { type A, B } from './value.js';",
  "export {} from './value.js';",
  "export * from './value.js';",
  'export const value = 1;',
  'export enum Value { A }',
  'export function value() {}',
  'export class Value {}',
  'value = 1;',
  'export default value;',
]) {
  test(`rejects runtime code disguised as types: ${text}`, () =>
    assert.ok(rules(`${source}/value.types.ts`, text).includes('FN006')));
}

test('test discovery markers stay in their existing roots', () => {
  for (const marker of ['test', 'integration.test', 'spec', 'cases']) {
    for (const extension of ['ts', 'tsx']) {
      assert.ok(
        rules(`${source}/value.${marker}.${extension}`).includes('FN007'),
      );
      assert.deepEqual(
        check(`packages/example/test/value.${marker}.${extension}`),
        [],
      );
    }
  }
});

test('scanner includes executable fixtures and declarations, skips absent roots, outputs and symlinks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pertexo-naming-'));
  const put = async (file, text = '') => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  };
  try {
    await put('apps/demo/src/z/Bad.ts');
    await put('packages/demo/test/fixtures/Bad.d.mts');
    await put('packages/demo/src/contract.ts');
    for (const ignored of ['dist', 'coverage', 'node_modules', '.git'])
      await put(`packages/demo/src/${ignored}/Bad.ts`);
    for (const ignored of [
      'migrations/Bad.sql',
      'src/Bad.json',
      'src/Bad.png',
      'Bad.config.ts',
    ])
      await put(`packages/demo/${ignored}`);
    await mkdir(path.join(root, 'outside'));
    await put('outside/Bad.ts');
    await symlink(
      path.join(root, 'outside'),
      path.join(root, 'apps/demo/src/linked'),
    );
    await symlink(
      path.join(root, 'outside/Bad.ts'),
      path.join(root, 'apps/demo/src/BadLink.ts'),
    );
    await mkdir(path.join(root, 'packages/linked'));
    await symlink(
      path.join(root, 'outside'),
      path.join(root, 'packages/linked/src'),
    );
    const diagnostics = await inspectFileNames(root);
    assert.deepEqual(
      diagnostics.map(({ path: file, rule }) => [file, rule]),
      [
        ['apps/demo/src/z/Bad.ts', 'FN001'],
        ['packages/demo/src/contract.ts', 'FN002'],
        ['packages/demo/test/fixtures/Bad.d.mts', 'FN001'],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('public feature interfaces and test support may implement their responsibility', () => {
  for (const file of [
    `${browser}/public.ts`,
    'packages/example/test/support/index.ts',
    'packages/example/test/support/fixture.types.ts',
  ])
    assert.deepEqual(check(file, 'export const value = 1;'), []);
});

test('entry imports may bind defaults and namespaces', () => {
  for (const text of [
    "import value from './value.js'; export { value };",
    "import * as values from './value.js'; export { values };",
  ])
    assert.deepEqual(check(`${source}/index.ts`, text), []);
});

for (const file of [
  'packages/core/src/runs/advance/contract.ts',
  'packages/core/src/attempts/validation/shared.ts',
  'packages/core/src/triggers/schedules/store.ts',
  'packages/core/src/outbox/dispatcher/input.ts',
  'apps/worker/src/runs/handler.ts',
  'apps/api/src/workflow-runs/events/index.ts',
  'packages/core/test/triggers/schedules/fixture.ts',
  'apps/worker/test/attempts/runtime.test.ts',
  'apps/api/test/webhooks/ingress/contract.types.ts',
]) {
  test(`execution modules retain a concrete subject: ${file}`, () => {
    assert.ok(rules(file).includes('FN008'));
  });
}

test('execution area entry points and subject-role modules remain valid', () => {
  for (const file of [
    'packages/core/src/runs/index.ts',
    'packages/core/src/attempts/index.ts',
    'packages/core/src/triggers/index.ts',
    'packages/core/src/outbox/index.ts',
    'apps/worker/src/attempts/delivery/handle-node-attempt-delivery.ts',
    'apps/api/src/pending-tasks/pending-task.service.ts',
    'packages/core/test/runs/run-store/coordinator-advance.fixture.ts',
  ])
    assert.deepEqual(check(file), []);
});

for (const file of [
  'packages/core/src/authoring/workflows/input.ts',
  'packages/core/src/lifecycle/purge/input.ts',
  'packages/core/src/governance/records.repository.ts',
  'packages/core/src/artifacts/uploads/input.ts',
  'packages/core/src/previews/attempts/state.repository.ts',
  'apps/api/src/workflow-authoring/organization/commands.ts',
  'apps/api/test/node-testing/use-case/fixture.ts',
  'apps/api/test/artifacts/service.test.ts',
  'apps/api/test/governance/errors.test.ts',
  'apps/worker/src/previews/handler.ts',
  'apps/worker/test/retention/runtime.test.ts',
]) {
  test(`batch D modules retain a concrete subject: ${file}`, () => {
    assert.ok(rules(file).includes('FN008'));
  });
}

test('batch D existing entry points and concrete fixture subjects remain valid', () => {
  for (const file of [
    ...['authoring', 'lifecycle', 'governance', 'artifacts', 'previews'].map(
      (area) => `packages/core/src/${area}/index.ts`,
    ),
    'apps/api/src/artifacts/index.ts',
    'apps/api/src/node-testing/index.ts',
    'apps/api/src/workflow-authoring/index.ts',
    'packages/core/test/lifecycle/workspace-purge.fixture.ts',
    'apps/api/test/node-testing/node-testing.fixture.ts',
    'apps/worker/src/previews/handle-preview-delivery.ts',
  ])
    assert.deepEqual(check(file), []);
});

for (const area of [
  'inbox',
  'notifications',
  'data-tables',
  'operator',
  'variables',
  'shared',
]) {
  test(`batch E requires a concrete subject in ${area}`, () => {
    assert.ok(rules(`packages/core/test/${area}/fixture.ts`).includes('FN008'));
    assert.deepEqual(check(`packages/core/src/${area}/index.ts`), []);
  });
}
