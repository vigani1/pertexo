import assert from 'node:assert/strict';
import test from 'node:test';

import { validateModuleImports } from './validate-module-imports.mjs';

const source = (a, b) => ({
  'packages/example/src/a.ts': a,
  'packages/example/src/b.ts': b,
});

test('accepts acyclic imports and resolves JavaScript specifiers to TypeScript', () => {
  assert.deepEqual(
    validateModuleImports(
      source("import { b } from './b.js';", 'export const b = 1;'),
    ),
    [],
  );
});

test('rejects direct runtime import/re-export cycles', () => {
  assert.match(
    validateModuleImports(
      source("import { b } from './b.js';", "export { a } from './a.js';"),
    ).join('\n'),
    /runtime module cycle/u,
  );
});

test('rejects side-effect and empty-named-import cycles', () => {
  for (const a of [
    "import './b.js';",
    "import {} from './b.js';",
    "export {} from './b.js';",
  ])
    assert.match(
      validateModuleImports(source(a, "import './a.js';")).join('\n'),
      /runtime module cycle/u,
    );
});

test('type-only relationships do not create runtime cycles', () => {
  for (const a of [
    "import type { B } from './b.js';",
    "import { type B } from './b.js';",
    "export type { B } from './b.js';",
    "export { type B } from './b.js';",
  ])
    assert.deepEqual(validateModuleImports(source(a, "import './a.js';")), []);
});

test('mixed type and value imports still create runtime cycles', () => {
  assert.match(
    validateModuleImports(
      source("import { type B, b } from './b.js';", "import './a.js';"),
    ).join('\n'),
    /runtime module cycle/u,
  );
});

test('deferred imports are not static initialization cycles', () => {
  assert.deepEqual(
    validateModuleImports(
      source("export const load = () => import('./b.js');", "import './a.js';"),
    ),
    [],
  );
});

test('rejects direct source traversal between workspaces, including types', () => {
  for (const declaration of [
    'import { value }',
    'import type { Value }',
    'export { value }',
  ])
    assert.match(
      validateModuleImports(
        source(`${declaration} from '../../other/src/index.js';`, ''),
      ).join('\n'),
      /public workspace package export/u,
    );
});

test('allows deliberate public package imports', () => {
  assert.deepEqual(
    validateModuleImports(
      source("import { value } from '@pertexo/model';", ''),
    ),
    [],
  );
});

test('deferred and inline type imports cannot bypass workspace ownership', () => {
  for (const statement of [
    "const load = () => import('../../other/src/index.js');",
    "type Value = import('../../other/src/index.js').Value;",
  ])
    assert.match(
      validateModuleImports(source(statement, '')).join('\n'),
      /public workspace package export/u,
    );
});
