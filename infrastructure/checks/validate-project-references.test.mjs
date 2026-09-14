import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inspectProjectReferences,
  validateProjectReferences,
} from './validate-project-references.mjs';

function fixture() {
  return [
    {
      name: '@repo/model',
      directory: 'packages/model',
      dependencies: {},
      references: [],
    },
    {
      name: '@repo/api',
      directory: 'apps/api',
      dependencies: { '@repo/model': 'workspace:*', zod: '4.0.0' },
      references: [{ path: '../../packages/model/tsconfig.json' }],
    },
  ];
}
const rootReferences = [
  { path: './packages/model/tsconfig.json' },
  { path: './apps/api/tsconfig.json' },
];

test('accepts dependency-aware references and ignores external dependencies', () => {
  assert.deepEqual(validateProjectReferences(fixture(), rootReferences), []);
});

test('rejects a workspace omitted from the root build', () => {
  assert.match(
    validateProjectReferences(fixture(), rootReferences.slice(1)).join('\n'),
    /root: missing reference to packages\/model/u,
  );
});

test('rejects missing, unexpected and duplicate references', () => {
  const workspaces = fixture();
  workspaces[1].references = [{ path: '../ghost' }, { path: '../ghost' }];
  const errors = validateProjectReferences(workspaces, rootReferences).join(
    '\n',
  );
  assert.match(errors, /missing reference to packages\/model/u);
  assert.match(errors, /unexpected reference to apps\/ghost/u);
  assert.match(errors, /duplicate project reference/u);
});

test('rejects unknown workspace dependencies', () => {
  const workspaces = fixture();
  workspaces[1].dependencies['@repo/missing'] = 'workspace:*';
  assert.match(
    validateProjectReferences(workspaces, rootReferences).join('\n'),
    /unknown workspace dependency @repo\/missing/u,
  );
});

test('rejects dependency cycles and dependencies on applications', () => {
  const workspaces = fixture();
  workspaces[0].dependencies['@repo/api'] = 'workspace:*';
  workspaces[0].references = [{ path: '../../apps/api' }];
  const errors = validateProjectReferences(workspaces, rootReferences).join(
    '\n',
  );
  assert.match(errors, /cannot depend on deployable application/u);
  assert.match(errors, /workspace dependency cycle/u);
});

test('accepts the actual repository graph', async () => {
  assert.deepEqual(await inspectProjectReferences(), []);
});
