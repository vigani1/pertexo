import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AREAS_NOT_YET_PASSED,
  inspectModuleImports,
  validateModuleImports,
} from './validate-module-imports.mjs';

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
    '@pertexo/core/runs',
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
  for (const specifier of ['@pertexo/core/variables', '@pertexo/core'])
    assert.match(
      imports(database, specifier).join('\n'),
      /only applications depend on core/u,
    );
  assert.match(
    validateModuleImports({
      [database]: "import type { A } from '@pertexo/core/variables';",
    }).join('\n'),
    /only applications depend on core/u,
  );
  assert.match(
    imports('packages/queue/src/a.ts', '@pertexo/core/variables').join('\n'),
    /only applications depend on core/u,
  );
  assert.deepEqual(imports('apps/api/src/a.ts', '@pertexo/core/variables'), []);
  for (const entry of ['schema', 'primitives']) {
    const specifier = `@pertexo/database/${entry}`;
    assert.match(
      imports('apps/worker/src/a.ts', specifier).join('\n'),
      /is for core/u,
    );
    assert.deepEqual(imports('packages/core/src/a/b.ts', specifier), []);
  }
});

test('a passed area is reached through the files its index names', () => {
  const area = (statement) =>
    validateModuleImports({
      'packages/core/src/runs/start.ts': statement,
      'packages/core/src/runs/own.ts': 'export const a = 1;',
      'packages/core/src/variables/index.ts':
        "export { a } from './public.js';\nexport type {} from './internal/named.js';",
      'packages/core/src/variables/public.ts': 'export const a = 1;',
      'packages/core/src/variables/private.ts': 'export const a = 1;',
      'packages/core/src/variables/internal/named.ts': 'export const a = 1;',
    });
  for (const form of [
    'import { a } from',
    'import type { A } from',
    'export { a } from',
  ]) {
    assert.match(
      area(`${form} '../variables/private.js';`).join('\n'),
      /it doesn't name private\.js/u,
    );
    assert.match(
      area(`${form} '../variables/index.js';`).join('\n'),
      /never the index/u,
    );
    assert.deepEqual(area(`${form} '../variables/public.js';`), []);
    assert.deepEqual(area(`${form} '../variables/internal/named.js';`), []);
  }
  assert.deepEqual(area("import { a } from './own.js';"), []);
});

test('naming a file with an empty type export adds no runtime edge', () => {
  assert.deepEqual(
    validateModuleImports({
      'packages/core/src/variables/index.ts':
        "export type {} from './named.js';",
      'packages/core/src/variables/named.ts':
        "import { a } from './index.js';\nexport const b = a;",
    }),
    [],
  );
});

test("an area not yet passed can be reached past its index, and one that has can't", () => {
  for (const area of AREAS_NOT_YET_PASSED)
    assert.deepEqual(
      validateModuleImports({
        'packages/core/src/variables/start.ts': `import { a } from '../${area}/deep/file.js';`,
      }),
      [],
      area,
    );
  for (const passed of ['variables', 'shared'])
    assert.match(
      validateModuleImports({
        'packages/core/src/runs/start.ts': `import { a } from '../${passed}/deep/file.js';`,
      }).join('\n'),
      /doesn't name deep\/file\.js/u,
      passed,
    );
});

test('the list of areas not yet passed can only shrink', () => {
  // A pass removes its area from both lists. Adding to this one, or to the check's,
  // is a decision to take in review: the rule exists so areas get off the list.
  const AT_THE_MOVE = [
    'attempts',
    'authoring',
    'connections',
    'data-tables',
    'execution',
    'governance',
    'identity',
    'inbox',
    'lifecycle',
    'notifications',
    'operator',
    'outbox',
    'previews',
    'runs',
    'tenant-access',
    'triggers',
  ];
  for (const area of AREAS_NOT_YET_PASSED)
    assert.ok(
      AT_THE_MOVE.includes(area),
      `${area} joined the list of areas not yet passed; it may only shrink`,
    );
  assert.ok(!AREAS_NOT_YET_PASSED.has('variables'));
  assert.ok(!AREAS_NOT_YET_PASSED.has('shared'));
});

test('an application reaches the database only through its platform door, and /testing from tests', () => {
  const imports = (file, specifier) =>
    validateModuleImports({ [file]: `import { a } from '${specifier}';` }).join(
      '\n',
    );
  for (const file of [
    'apps/api/src/a.ts',
    'apps/worker/test/a.test.ts',
    'apps/web/e2e/a.spec.ts',
  ])
    for (const specifier of [
      '@pertexo/database',
      '@pertexo/database/runs',
      '@pertexo/database/authoring',
      '@pertexo/database/anything-new',
    ])
      assert.match(
        imports(file, specifier),
        /reach the database only through/u,
        `${file}: ${specifier}`,
      );
  assert.equal(imports('apps/api/src/a.ts', '@pertexo/database/platform'), '');
  assert.equal(imports('apps/api/test/a.ts', '@pertexo/database/platform'), '');
  assert.equal(imports('apps/api/test/a.ts', '@pertexo/database/testing'), '');
  assert.match(
    imports('apps/api/src/a.ts', '@pertexo/database/testing'),
    /holds test flows/u,
  );
  assert.equal(
    imports('packages/core/src/a/b.ts', '@pertexo/database/platform'),
    '',
  );
});

test('a listed area with no folder in core is reported, so the list stays true', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'module-imports-'));
  try {
    for (const area of AREAS_NOT_YET_PASSED)
      await mkdir(path.join(directory, 'packages/core/src', area), {
        recursive: true,
      });
    await mkdir(path.join(directory, 'apps'), { recursive: true });
    assert.deepEqual(await inspectModuleImports(directory), []);
    await rm(path.join(directory, 'packages/core/src/runs'), {
      recursive: true,
    });
    assert.match(
      (await inspectModuleImports(directory)).join('\n'),
      /runs is on AREAS_NOT_YET_PASSED/u,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('a test door never reaches code that ships', () => {
  for (const specifier of [
    '@pertexo/database/testing',
    '@pertexo/core/testing',
  ])
    for (const file of [
      'apps/api/src/a.ts',
      'packages/queue/src/a.ts',
      'packages/core/src/variables/a.ts',
    ]) {
      for (const statement of [
        `import { a } from '${specifier}';`,
        `import type { A } from '${specifier}';`,
        `export { a } from '${specifier}';`,
        `const a = () => import('${specifier}');`,
      ])
        assert.match(
          validateModuleImports({ [file]: statement }).join('\n'),
          /holds test flows/u,
          `${file}: ${statement}`,
        );
    }
  assert.deepEqual(
    validateModuleImports({
      'apps/api/test/a.ts': "import { a } from '@pertexo/database/testing';",
      'packages/core/test/a.ts': "import { a } from '@pertexo/core/testing';",
    }),
    [],
  );
});

test("an application's tests stay out of core's database entry points", () => {
  for (const entry of ['schema', 'primitives'])
    for (const file of [
      'apps/api/test/a.ts',
      'apps/worker/test/a.integration.test.ts',
      'apps/web/e2e/a.spec.ts',
      'apps/web/e2e-live/a.spec.ts',
    ])
      assert.match(
        validateModuleImports({
          [file]: `import { a } from '@pertexo/database/${entry}';`,
        }).join('\n'),
        /is for core/u,
        `${file}: ${entry}`,
      );
  assert.deepEqual(
    validateModuleImports({
      'packages/core/test/a.ts':
        "import { a } from '@pertexo/database/schema';",
      'packages/database/test/a.ts':
        "import { a } from '@pertexo/database/schema';",
    }),
    [],
  );
});

test("an application's tests can't reach the database's code by relative path", () => {
  for (const [file, specifier] of [
    ['apps/api/test/a.ts', '../../../packages/database/src/schema.js'],
    ['apps/api/test/a.ts', '../../../packages/database/src/primitives.js'],
    ['apps/api/test/a.ts', '../../../packages/database/src/schema/runs/a'],
    ['apps/api/test/a.ts', '../../../packages/database/dist/schema.js'],
    ['apps/web/e2e/a/b.spec.ts', '../../../../packages/database/src/schema.js'],
    ['apps/web/e2e-live/a.spec.ts', '../../../packages/database/src/schema.js'],
  ])
    for (const statement of [
      `import { a } from '${specifier}';`,
      `import type { A } from '${specifier}';`,
      `export { a } from '${specifier}';`,
      `const a = () => import('${specifier}');`,
    ])
      assert.match(
        validateModuleImports({ [file]: statement }).join('\n'),
        /is for core/u,
        `${file}: ${statement}`,
      );
  assert.deepEqual(
    validateModuleImports({
      'apps/api/test/fixtures.ts':
        "import { a } from '../../../packages/database/test/support.js';",
      'apps/web/test/catalog.ts':
        "import { a } from '../../../packages/node-catalog/dist/index.js';",
      'packages/core/test/a.ts': "import { a } from '../../database/src/a.js';",
      'packages/database/test/a.ts': "import { a } from '../src/schema.js';",
    }),
    [],
  );
});

test('the scan reads tests, and holds them only to the direction rules', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'module-imports-'));
  try {
    await mkdir(path.join(directory, 'packages/placeholder'), {
      recursive: true,
    });
    for (const folder of ['test', 'e2e', 'e2e-live']) {
      await mkdir(path.join(directory, 'apps/web', folder), {
        recursive: true,
      });
      await writeFile(
        path.join(directory, 'apps/web', folder, 'a.ts'),
        "import { a } from '@pertexo/database/schema';",
      );
    }
    assert.equal(
      (await inspectModuleImports(directory)).filter((error) =>
        /is for core/u.test(error),
      ).length,
      3,
    );

    await rm(path.join(directory, 'apps'), { recursive: true });
    await mkdir(path.join(directory, 'apps/api/test'), { recursive: true });
    await writeFile(
      path.join(directory, 'apps/api/test/a.ts'),
      "import { a } from '../../../packages/database/test/support.js';\nimport { b } from '@pertexo/api/x';\nexport const load = () => fetch('/x');",
    );
    assert.deepEqual(await inspectModuleImports(directory), []);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('a dynamic import in a template literal is held to the same rules', () => {
  const load = (specifier) => `const load = () => import(\`${specifier}\`);`;
  assert.match(
    validateModuleImports({
      'apps/api/src/a.ts': load('@pertexo/database/schema'),
    }).join('\n'),
    /is for core/u,
  );
  assert.match(
    validateModuleImports({
      'packages/queue/src/a.ts': load('@pertexo/core/variables'),
    }).join('\n'),
    /only applications depend on core/u,
  );
  assert.match(
    validateModuleImports(source(load('../../other/src/index.js'), '')).join(
      '\n',
    ),
    /public workspace package export/u,
  );
});

test('import-equals is held to the same rules', () => {
  const load = (specifier) => `import a = require('${specifier}');`;
  assert.match(
    validateModuleImports({
      'apps/api/src/a.ts': load('@pertexo/database/schema'),
    }).join('\n'),
    /is for core/u,
  );
  assert.match(
    validateModuleImports({
      'packages/queue/src/a.ts': load('@pertexo/core/variables'),
    }).join('\n'),
    /only applications depend on core/u,
  );
  assert.match(
    validateModuleImports(source(load('./b.js'), "import './a.js';")).join(
      '\n',
    ),
    /runtime module cycle/u,
  );
});

test('a package reaches its own code by relative path', () => {
  for (const [file, specifier] of [
    ['packages/core/src/runs/start.ts', '@pertexo/core/variables'],
    ['packages/core/src/runs/start.ts', '@pertexo/core'],
    ['packages/database/src/runs/a.ts', '@pertexo/database/schema'],
    ['apps/worker/src/a.ts', '@pertexo/worker'],
  ])
    for (const statement of [
      `import { a } from '${specifier}';`,
      `import type { A } from '${specifier}';`,
      `const a = () => import('${specifier}');`,
    ])
      assert.match(
        validateModuleImports({ [file]: statement }).join('\n'),
        /reaches its own code/u,
        `${file}: ${statement}`,
      );
  assert.deepEqual(
    validateModuleImports({
      'packages/nodes-core/src/a.ts': "import { a } from '@pertexo/core-ish';",
      'packages/core/test/a.ts': "import { a } from '@pertexo/core/variables';",
    }),
    [],
  );
});

test("a core area doesn't import the entry points above it", () => {
  for (const specifier of ['../server.js', '../testing.js'])
    for (const statement of [
      `import { a } from '${specifier}';`,
      `import type { A } from '${specifier}';`,
    ])
      assert.match(
        validateModuleImports({
          'packages/core/src/runs/start.ts': statement,
          'packages/core/src/server.ts': 'export const a = 1;',
          'packages/core/src/testing.ts': 'export const a = 1;',
        }).join('\n'),
        /don't import core's entry points/u,
        statement,
      );
  assert.deepEqual(
    validateModuleImports({
      'packages/core/src/testing.ts': "export { a } from './runs/index.js';",
      'packages/core/src/runs/index.ts': 'export const a = 1;',
    }),
    [],
  );
});
