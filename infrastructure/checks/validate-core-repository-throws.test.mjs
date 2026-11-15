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

test("core's repositories throw no domain errors", async () => {
  assert.deepEqual(
    repositoryThrowFindings(await collectRepositoryThrows()),
    [],
  );
});
