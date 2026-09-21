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

test('web source allows only reviewed workspace package subpaths', () => {
  const allowed = {
    'apps/web/src/features/artifacts/artifacts.api.ts':
      "import { artifactMetadataResponseSchema } from '@pertexo/contracts/schemas/artifacts';",
    'apps/web/src/lib/api/client.ts':
      "import { apiProblemSchema } from '@pertexo/contracts/schemas/errors';",
    'apps/web/src/features/session/session.api.ts':
      "import { accessibleWorkspacesResponseSchema } from '@pertexo/contracts/schemas/identity-workspace';",
    'apps/web/src/features/workflows/workflows.api.ts':
      "import { workflowListResponseSchema } from '@pertexo/contracts/schemas/workflow-authoring';",
    'apps/web/src/features/connections/connections.api.ts':
      "import { connectionListResponseSchema } from '@pertexo/contracts/schemas/connections';",
    'apps/web/src/features/catalog/catalog.api.ts':
      "import { nodeDefinitionListResponseSchema } from '@pertexo/contracts/schemas/catalog';",
    'apps/web/src/features/publish/node-preview.api.ts':
      "import { nodeTestRequestSchema } from '@pertexo/contracts/schemas/node-testing';",
    'apps/web/src/features/runs/runs.api.ts':
      "import { workflowRunResponseSchema } from '@pertexo/contracts/schemas/workflow-runs';",
    'apps/web/src/features/settings/notifications.api.ts':
      "import { failureNotificationDestinationListResponseSchema } from '@pertexo/contracts/schemas/failure-notifications';",
    'apps/web/src/features/settings/schedules.api.ts':
      "import { scheduleTriggerListResponseSchema } from '@pertexo/contracts/schemas/schedules';",
    'apps/web/src/features/settings/webhooks.api.ts':
      "import { webhookTriggerListResponseSchema } from '@pertexo/contracts/schemas/webhooks';",
    'apps/web/src/features/workflow-editor/model/input-mappings.ts':
      "import { parseJsonPath } from '@pertexo/workflow-model/json-path';",
  };
  assert.deepEqual(validateModuleImports(allowed), []);

  for (const specifier of [
    '@pertexo/contracts',
    '@pertexo/contracts/errors',
    '@pertexo/contracts/schemas/transport-internals',
    '@pertexo/workflow-model',
    '@pertexo/database/api',
  ])
    assert.match(
      validateModuleImports({
        'apps/web/src/probe.ts': `import { value } from '${specifier}';`,
      }).join('\n'),
      /unreviewed workspace package path/u,
    );
});

test('web aliases and TSX files participate in runtime cycle checks', () => {
  assert.match(
    validateModuleImports({
      'apps/web/src/a.tsx': "import { b } from '@/b'; export const a = b;",
      'apps/web/src/b.ts': "import { a } from './a'; export const b = a;",
    }).join('\n'),
    /runtime module cycle/u,
  );
});

test('web cross-feature imports use deliberate public interfaces', () => {
  assert.match(
    validateModuleImports({
      'apps/web/src/features/editor/editor.tsx':
        "import { publish } from '@/features/publish/private'; export const editor = publish;",
      'apps/web/src/features/publish/private.ts':
        'export const publish = true;',
    }).join('\n'),
    /cross-feature imports must use @\/features\/publish\/public/u,
  );
  assert.deepEqual(
    validateModuleImports({
      'apps/web/src/features/editor/editor.tsx':
        "import { publish } from '@/features/publish/commands.public'; export const editor = publish;",
      'apps/web/src/features/publish/commands.public.ts':
        'export const publish = true;',
    }),
    [],
  );
});

test('web source restricts raw fetch to the transport adapter', () => {
  assert.match(
    validateModuleImports({
      'apps/web/src/features/example/example.api.ts':
        "export const load = () => fetch('/v1/example');",
    }).join('\n'),
    /raw fetch belongs in the reviewed web transport adapter/u,
  );
  assert.deepEqual(
    validateModuleImports({
      'apps/web/src/lib/api/client.ts':
        "export const load = () => globalThis.fetch('/v1/example');",
    }),
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
