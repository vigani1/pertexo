import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  collectCoreFindings,
  findDomainThrows,
  repositoryHops,
  repositoryThrowFindings,
  staleExemptionFindings,
  throwingFunctions,
} from './validate-core-repository-throws.mjs';

const REPOSITORY = 'packages/core/src/runs/example.repository.ts';
const names = (text, file = REPOSITORY) =>
  findDomainThrows(file, text).map((t) => t.name);

test('finds domain errors and thrown calls in a repository', () => {
  assert.deepEqual(
    names(`
      if (!row) throw new WorkflowNotFoundError();
      if (conflict) throw refusal('limit');
      if (stale) throw errors.conflict();
    `),
    ['WorkflowNotFoundError', 'refusal()', 'errors.conflict()'],
  );
});

test('lets storage integrity errors and rethrows through', () => {
  assert.deepEqual(
    names(`
      if (!row) throw new Error('Write returned no row');
      if (bad) throw new CoordinatorRunStateCorruptError();
      try { await write(); } catch (error) { throw error; }
    `),
    [],
  );
});

test('looks only at core repositories', () => {
  const text = 'throw new WorkflowNotFoundError();';
  assert.deepEqual(names(text, 'packages/core/src/runs/start-run.ts'), []);
  assert.deepEqual(names(text, 'packages/core/src/runs/run.store.ts'), []);
  assert.deepEqual(names(text, 'apps/api/src/x.repository.ts'), []);
});

test('every domain throw in a repository is a finding', () => {
  const findings = repositoryThrowFindings(
    new Map([
      [
        REPOSITORY,
        [{ file: REPOSITORY, line: 7, name: 'WorkflowNotFoundError' }],
      ],
      ['packages/core/src/runs/clean.repository.ts', []],
    ]),
  );
  assert.equal(findings.length, 1);
  assert.match(
    findings[0],
    /example\.repository\.ts:7: WorkflowNotFoundError/u,
  );
});

test('sees through a built variable, a rejection, parentheses and casts', () => {
  assert.deepEqual(
    names(`
      const refusal = new WorkflowNotFoundError();
      if (a) throw refusal;
      if (b) return Promise.reject(new WorkflowTagConflictError('key'));
      if (c) throw (new DataTableError('limit'));
      if (d) throw new DirectoryError('stale') as unknown;
    `),
    [
      'WorkflowNotFoundError',
      'WorkflowTagConflictError',
      'DataTableError',
      'DirectoryError',
    ],
  );
});

test('an error class imported as Error is still that class', () => {
  assert.deepEqual(
    names(`
      import { WorkflowNotFoundError as Error } from './errors.js';
      throw new Error('Workflow is not visible');
    `),
    ['WorkflowNotFoundError'],
  );
});

test('a rejection handler that passes its error on is a rethrow', () => {
  assert.deepEqual(
    names(`
      await work().catch((error: unknown) => {
        if (error instanceof DeliveryMismatch) return undefined;
        throw error;
      });
    `),
    [],
  );
});

test('a repository may not call an operation that throws for it', () => {
  const operation = 'packages/core/src/runs/require-run.ts';
  const throwing = new Map([
    [
      operation,
      throwingFunctions(
        operation,
        `export function requireRun(run) {
          if (run === undefined) throw new WorkflowRunNotFoundError();
          return run;
        }
        export function decodeStoredValue(read) { return read(); }`,
      ),
    ],
  ]);
  assert.deepEqual(
    repositoryHops(
      REPOSITORY,
      `import { requireRun, decodeStoredValue } from './require-run.js';
       import type { requireRun as Typed } from './require-run.js';`,
      throwing,
    ).map(({ name }) => name),
    ['requireRun'],
  );
});

test('a listed integrity decoder may be called', () => {
  const decoder = 'packages/core/src/shared/stored-values.ts';
  assert.deepEqual(
    [
      ...throwingFunctions(
        decoder,
        `export function decodeStoredValue(read) {
          const failure = new StoredValueError();
          throw failure;
        }`,
      ),
    ],
    [],
  );
});

test('an exemption core never uses is refused', () => {
  assert.match(
    staleExemptionFindings(['throw new Error();']).join('\n'),
    /lists CoordinatorRunStateCorruptError, which core never throws/u,
  );
});

test("core's repositories throw and reach no domain errors", async () => {
  assert.deepEqual(await collectCoreFindings(), []);
});

for (const [shape, text] of [
  [
    'default parameter',
    'function refuse(error = new WorkflowRunNotFoundError()) { throw error; }',
  ],
  ['ordinary parameter', 'function refuse(error) { throw error; }'],
  [
    'conditional first branch',
    'throw missing ? new WorkflowRunNotFoundError() : new Error();',
  ],
  [
    'conditional second branch',
    'throw missing ? new Error() : new WorkflowRunNotFoundError();',
  ],
  ['logical fallback', 'throw error || new WorkflowRunNotFoundError();'],
  ['nullish fallback', 'throw error ?? new WorkflowRunNotFoundError();'],
  [
    'conditional rejection',
    'Promise.reject(missing ? new Error() : new WorkflowRunNotFoundError());',
  ],
  [
    'logical rejection',
    'Promise.reject(error || new WorkflowRunNotFoundError());',
  ],
  [
    'nullish rejection',
    'Promise.reject(error ?? new WorkflowRunNotFoundError());',
  ],
])
  test(`refuses ${shape}`, () => assert.ok(names(text).length > 0));

for (const [shape, text] of [
  [
    'namespace import',
    "import * as g from './require-run.js'; g.requireRun();",
  ],
  [
    'dynamic import',
    "const g = await import('./require-run.js'); g.requireRun();",
  ],
  [
    'unresolved dynamic import',
    'const g = await import(moduleName); g.requireRun();',
  ],
])
  test(`refuses ${shape} reaching operations`, () => {
    const modules = new Map([
      ['packages/core/src/runs/require-run.ts', new Set(['requireRun'])],
    ]);
    assert.ok(repositoryHops(REPOSITORY, text, modules).length > 0);
  });

test('indexes throwing methods of exported classes', () => {
  assert.ok(
    throwingFunctions(
      'guard.ts',
      'export class Guard { requireRun() { throw new WorkflowRunNotFoundError(); } }',
    ).has('Guard'),
  );
});

for (const forwarding of [
  "export { requireRun } from './require-run.js';",
  "export * from './require-run.js';",
  "export { requireRun as refuse } from './require-run.js';",
])
  test(`follows re-export: ${forwarding}`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'core-throws-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const area = path.join(root, 'packages/core/src/runs');
    await mkdir(area, { recursive: true });
    await writeFile(
      path.join(area, 'require-run.ts'),
      'export function requireRun() { throw new WorkflowRunNotFoundError(); }',
    );
    await writeFile(path.join(area, 'forward.ts'), forwarding);
    const name = forwarding.includes('as refuse') ? 'refuse' : 'requireRun';
    await writeFile(
      path.join(area, 'example.repository.ts'),
      `import { ${name} } from './forward.js'; ${name}();`,
    );
    assert.ok(
      (await collectCoreFindings(root)).some((finding) =>
        finding.includes('example.repository.ts'),
      ),
    );
  });

test('a default-imported throwing class cannot enter a repository', () => {
  const target = 'packages/core/src/runs/guard.ts';
  const throwing = throwingFunctions(
    target,
    'export default class Guard { requireRun() { throw new WorkflowRunNotFoundError(); } }',
  );
  assert.ok(
    repositoryHops(
      REPOSITORY,
      "import Guard from './guard.js'; new Guard().requireRun();",
      new Map([[target, throwing]]),
    ).length > 0,
  );
});

test('only genuine rejection parameters are rethrows', () => {
  assert.deepEqual(
    names('work().then(undefined, (error) => { throw error; });'),
    [],
  );
  assert.ok(
    names(
      'work().catch((error = new WorkflowRunNotFoundError()) => { throw error; });',
    ).length > 0,
  );
});
