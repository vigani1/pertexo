import assert from 'node:assert/strict';
import test from 'node:test';

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
