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
      "import { artifactMetadataResponseSchema } from '@pertexo/contracts';",
    'apps/web/src/lib/api/client.ts':
      "import { apiProblemSchema } from '@pertexo/contracts';",
    'apps/web/src/features/session/session.api.ts':
      "import { accessibleWorkspacesResponseSchema } from '@pertexo/contracts';",
    'apps/web/src/features/workflows/workflows.api.ts':
      "import { workflowListResponseSchema } from '@pertexo/contracts';",
    'apps/web/src/features/workflows/workflow-portability.api.ts':
      "import { workflowImportResponseSchema } from '@pertexo/contracts';",
    'apps/web/src/features/connections/connections.api.ts':
      "import { connectionListResponseSchema } from '@pertexo/contracts';",
    'apps/web/src/features/catalog/catalog.api.ts':
      "import { nodeDefinitionListResponseSchema } from '@pertexo/contracts';",
    'apps/web/src/features/publish/node-preview.api.ts':
      "import { nodeTestRequestSchema } from '@pertexo/contracts';",
    'apps/web/src/features/runs/runs.api.ts':
      "import { workflowRunResponseSchema } from '@pertexo/contracts';",
    'apps/web/src/features/settings/notifications.api.ts':
      "import { failureNotificationDestinationListResponseSchema } from '@pertexo/contracts';",
    'apps/web/src/features/settings/schedules.api.ts':
      "import { scheduleTriggerListResponseSchema } from '@pertexo/contracts';",
    'apps/web/src/features/settings/webhooks.api.ts':
      "import { webhookTriggerListResponseSchema } from '@pertexo/contracts';",
    'apps/web/src/features/workflow-editor/model/code-source.ts':
      "import { inspectCodeSource } from '@pertexo/node-sdk';",
    'apps/web/src/features/workflow-editor/model/input-mappings.ts':
      "import { parseJsonPath } from '@pertexo/workflow-model';",
    'apps/web/src/features/workflow-editor/model/http-body.ts':
      "import { httpMultipartConfigSchema } from '@pertexo/integrations';",
    'apps/web/src/features/workflows/model/curated-templates.ts':
      "import { CURATED_WORKFLOW_TEMPLATES } from '@pertexo/templates';",
  };
  assert.deepEqual(validateModuleImports(allowed), []);

  for (const specifier of [
    '@pertexo/node-sdk/server',
    '@pertexo/contracts/server',
    '@pertexo/contracts/errors',
    '@pertexo/workflow-model/server',
    '@pertexo/database/runs',
    '@pertexo/integrations/server',
    '@pertexo/integrations/http-request/multipart/encode',
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
      'apps/web/src/features/artifacts/data/upload.api.ts':
        "export const upload = () => fetch('https://objects.example.test/file', { credentials: 'omit' });",
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

test('Code runner can use only the credential-free SDK workspace dependency', () => {
  for (const specifier of [
    '@pertexo/database/platform',
    '@pertexo/queue',
    '@pertexo/integrations',
    '@pertexo/execution',
  ])
    assert.match(
      validateModuleImports({
        'apps/code-runner/src/app.ts': `import '${specifier}';`,
      }).join('\n'),
      /Code runner may depend only/u,
    );
  assert.deepEqual(
    validateModuleImports({
      'apps/code-runner/src/app.ts': "import '@pertexo/node-sdk/server';",
    }),
    [],
  );
});

test('keeps the direction apps -> core -> database', () => {
  const imports = (file, specifier) =>
    validateModuleImports({ [file]: `import '${specifier}';` });
  const database = 'packages/database/src/runs/advance.ts';
  for (const specifier of ['@pertexo/core/server', '@pertexo/core'])
    assert.match(
      imports(database, specifier).join('\n'),
      /only applications depend on core/u,
    );
  assert.match(
    validateModuleImports({
      [database]: "import type { A } from '@pertexo/core/server';",
    }).join('\n'),
    /only applications depend on core/u,
  );
  assert.match(
    imports('packages/execution/src/a.ts', '@pertexo/core/server').join('\n'),
    /only applications depend on core/u,
  );
  assert.deepEqual(imports('apps/api/src/a.ts', '@pertexo/core/server'), []);
  for (const entry of ['schema', 'primitives']) {
    const specifier = `@pertexo/database/${entry}`;
    assert.match(
      imports('apps/worker/src/a.ts', specifier).join('\n'),
      /is for core/u,
    );
    assert.deepEqual(imports('packages/core/src/a/b.ts', specifier), []);
  }
});

test('core areas meet at their index', () => {
  const area = (specifier) =>
    validateModuleImports({
      'packages/core/src/runs/start.ts': `import { a } from '${specifier}';`,
      'packages/core/src/runs/own.ts': 'export const a = 1;',
      'packages/core/src/variables/index.ts': 'export const a = 1;',
      'packages/core/src/variables/private.ts': 'export const a = 1;',
    });
  assert.match(
    area('../variables/private.js').join('\n'),
    /core areas meet at their index/u,
  );
  assert.deepEqual(area('../variables/index.js'), []);
  assert.deepEqual(area('./own.js'), []);
});
