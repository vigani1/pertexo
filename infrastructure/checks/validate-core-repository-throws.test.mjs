import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectRepositoryThrows,
  findDomainThrows,
  repositoryThrowFindings,
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

test('the backlog only shrinks', () => {
  const thrown = (count) =>
    Array.from({ length: count }, (_, line) => ({
      file: REPOSITORY,
      line,
      name: 'WorkflowNotFoundError',
    }));
  const backlog = { [REPOSITORY]: 2 };
  assert.deepEqual(
    repositoryThrowFindings(new Map([[REPOSITORY, thrown(2)]]), backlog),
    [],
  );
  assert.match(
    repositoryThrowFindings(new Map([[REPOSITORY, thrown(3)]]), backlog)[0],
    /3 domain throw\(s\) in a repository, 2 allowed/u,
  );
  assert.match(
    repositoryThrowFindings(new Map([[REPOSITORY, thrown(1)]]), backlog)[0],
    /lower its entry/u,
  );
  assert.match(
    repositoryThrowFindings(new Map([[REPOSITORY, []]]), backlog)[0],
    /remove it/u,
  );
  assert.match(
    repositoryThrowFindings(new Map(), backlog)[0],
    /no longer a core repository/u,
  );
  assert.match(
    repositoryThrowFindings(
      new Map([['packages/core/src/a/new.repository.ts', thrown(1)]]),
      backlog,
    )[0],
    /0 allowed/u,
  );
});

test("core's repositories match the backlog", async () => {
  assert.deepEqual(
    repositoryThrowFindings(await collectRepositoryThrows()),
    [],
  );
});
