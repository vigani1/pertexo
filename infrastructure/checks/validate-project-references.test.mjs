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

test('only applications and core may depend on secrets, even for tests', () => {
  const secrets = {
    name: '@pertexo/secrets',
    directory: 'packages/secrets',
    references: [],
  };
  const core = {
    name: '@pertexo/core',
    directory: 'packages/core',
    dependencies: { '@pertexo/secrets': 'workspace:*' },
    references: [{ path: '../secrets/tsconfig.json' }],
  };
  const [model, api] = fixture();
  const roots = [
    ...rootReferences,
    { path: './packages/core/tsconfig.json' },
    { path: './packages/secrets/tsconfig.json' },
  ];
  assert.deepEqual(
    validateProjectReferences([model, api, core, secrets], roots),
    [],
  );
  assert.match(
    validateProjectReferences(
      [
        {
          ...model,
          devDependencies: { '@pertexo/secrets': 'workspace:*' },
        },
        api,
        core,
        secrets,
      ],
      roots,
    ).join('\n'),
    /only applications and core depend on secrets/u,
  );
});

test('only applications may depend on core, even for tests', () => {
  const core = {
    name: '@pertexo/core',
    directory: 'packages/core',
    dependencies: { '@repo/model': 'workspace:*' },
    references: [{ path: '../model/tsconfig.json' }],
  };
  const roots = [...rootReferences, { path: './packages/core/tsconfig.json' }];
  for (const kind of ['dependencies', 'devDependencies']) {
    const [model, api] = fixture();
    model[kind] = { '@pertexo/core': 'workspace:*' };
    model.references =
      kind === 'dependencies' ? [{ path: '../core/tsconfig.json' }] : [];
    assert.match(
      validateProjectReferences([model, api, core], roots).join('\n'),
      /only applications depend on core/u,
    );
  }
  const [model, api] = fixture();
  api.dependencies['@pertexo/core'] = 'workspace:*';
  api.references.push({ path: '../../packages/core/tsconfig.json' });
  assert.deepEqual(validateProjectReferences([model, api, core], roots), []);
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
