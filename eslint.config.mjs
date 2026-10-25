import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

const nodeGlobals = Object.fromEntries(
  Object.getOwnPropertyNames(globalThis).map((name) => [name, 'readonly']),
);

const workflowModelLayer = {
  group: [
    '**/apps/**',
    '@nestjs/*',
    '@pertexo/api',
    '@pertexo/api/*',
    '@pertexo/artifact-store',
    '@pertexo/artifact-store/*',
    '@pertexo/database',
    '@pertexo/database/*',
    '@pertexo/observability',
    '@pertexo/observability/*',
    '@pertexo/queue',
    '@pertexo/queue/*',
    '@pertexo/worker',
    '@pertexo/worker/*',
    '@pertexo/workflow-engine',
    '@pertexo/workflow-engine/*',
    '@pertexo/node-sdk',
    '@pertexo/node-sdk/*',
    '@pertexo/nodes-core',
    '@pertexo/nodes-core/*',
    '@pertexo/node-catalog',
    '@pertexo/node-catalog/*',
    '@pertexo/contracts',
    '@pertexo/contracts/*',
    '@pertexo/execution',
    '@pertexo/execution/*',
    '@pertexo/templates',
    '@pertexo/templates/*',
    'bullmq',
    'drizzle-orm',
    'ioredis',
  ],
  message:
    'The workflow model is a lower-level deterministic contract and cannot depend on the engine or server infrastructure.',
};

// Each lint process uses its owner's program instead of opening unrelated apps.
const workspaceTypeProjects = ['apps', 'packages'].flatMap((area) =>
  readdirSync(join(import.meta.dirname, area), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const workspace = `${area}/${entry.name}`;
      if (!existsSync(join(import.meta.dirname, workspace, 'tsconfig.json')))
        return [];
      return [
        {
          files: [`${workspace}/**/*.{ts,tsx,mts,cts}`],
          languageOptions: {
            parserOptions: { project: [`${workspace}/tsconfig.json`] },
          },
        },
        {
          files: [
            `${workspace}/**/scripts/**/*.ts`,
            `${workspace}/**/test/**/*.ts`,
            `${workspace}/**/vitest*.config.ts`,
          ],
          languageOptions: {
            parserOptions: { project: [`${workspace}/tsconfig.test.json`] },
          },
        },
      ];
    }),
);

const readablePackages = [
  'workflow-engine',
  'workflow-model',
  'node-sdk',
  'nodes-core',
  'integrations',
  'node-catalog',
  'templates',
  'contracts',
  'database',
  'artifact-store',
  'queue',
  'observability',
  'rate-limit',
  'execution',
];

const readableWorkspaces = [
  ...readablePackages.map((name) => `packages/${name}`),
  ...['api', 'worker', 'code-runner', 'cli', 'ops'].map(
    (name) => `apps/${name}`,
  ),
];

export const readabilityRules = {
  'no-nested-ternary': 'error',
  'no-else-return': 'error',
  complexity: ['error', 20],
  'max-depth': ['error', 4],
  'max-params': ['error', 4],
  'max-lines-per-function': ['error', 150],
  'max-lines': ['error', 400],
  '@typescript-eslint/switch-exhaustiveness-check': 'error',
};

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ['apps/*/tsconfig.json', 'packages/*/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error',
      // Omit a property by destructuring it beside a rest element, and mark a
      // deliberately unused parameter or binding with a leading underscore.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          ignoreRestSiblings: true,
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: [
      '**/scripts/**/*.ts',
      '**/test/**/*.ts',
      '**/vitest*.config.ts',
      'infrastructure/testing/**/*.d.mts',
    ],
    languageOptions: {
      parserOptions: {
        project: ['apps/*/tsconfig.test.json', 'packages/*/tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  ...workspaceTypeProjects,
  {
    files: ['packages/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@pertexo/database',
              message:
                'Import a database area entry point, such as @pertexo/database/runs.',
            },
          ],
          patterns: [
            {
              group: [
                '**/apps/**',
                '@pertexo/api',
                '@pertexo/api/*',
                '@pertexo/worker',
                '@pertexo/worker/*',
              ],
              message: 'Packages cannot depend on deployable applications.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/database/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@pertexo/nodes-core',
              allowImportNames: ['CORE_SCHEDULE_CONFIG_SCHEMA'],
              allowTypeImports: true,
              message:
                'Storage may read the shared schedule configuration; node execution and request projection belong to callers.',
            },
            {
              name: '@pertexo/database',
              message:
                'Import a database area entry point, such as @pertexo/database/runs.',
            },
          ],
          patterns: [
            {
              group: [
                '@pertexo/contracts',
                '@pertexo/contracts/*',
                '@pertexo/templates',
                '@pertexo/templates/*',
              ],
              allowTypeImports: true,
              message:
                'Storage may use transport read-model and template types, never their runtime schemas or rules. Import domain rules from their owner.',
            },
            {
              group: [
                '**/apps/**',
                '@nestjs/*',
                '@pertexo/api',
                '@pertexo/api/*',
                '@pertexo/artifact-store',
                '@pertexo/artifact-store/*',
                '@pertexo/observability',
                '@pertexo/observability/*',
                '@pertexo/queue',
                '@pertexo/queue/*',
                '@pertexo/worker',
                '@pertexo/worker/*',
                '@pertexo/execution',
                '@pertexo/execution/*',
                'bullmq',
                'ioredis',
              ],
              message:
                'The database package is a server persistence leaf and cannot depend on actions, frameworks, queues, observability, or applications.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/observability/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/apps/**',
                '@nestjs/*',
                '@pertexo/api',
                '@pertexo/api/*',
                '@pertexo/artifact-store',
                '@pertexo/artifact-store/*',
                '@pertexo/database',
                '@pertexo/database/*',
                '@pertexo/queue',
                '@pertexo/queue/*',
                '@pertexo/worker',
                '@pertexo/worker/*',
                'bullmq',
                'drizzle-orm',
                'ioredis',
              ],
              message:
                'The observability package cannot depend on application frameworks, persistence, queues, or deployable applications.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/queue/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/apps/**',
                '@nestjs/*',
                '@pertexo/api',
                '@pertexo/api/*',
                '@pertexo/artifact-store',
                '@pertexo/artifact-store/*',
                '@pertexo/database',
                '@pertexo/database/*',
                '@pertexo/worker',
                '@pertexo/worker/*',
                'drizzle-orm',
              ],
              message:
                'The queue package owns transport contracts and adapters, not persistence, artifacts, frameworks, or applications.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/artifact-store/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/apps/**',
                '@nestjs/*',
                '@pertexo/api',
                '@pertexo/api/*',
                '@pertexo/database',
                '@pertexo/database/*',
                '@pertexo/queue',
                '@pertexo/queue/*',
                '@pertexo/worker',
                '@pertexo/worker/*',
                'bullmq',
                'drizzle-orm',
                'ioredis',
              ],
              message:
                'The artifact-store package owns bounded object storage only, not persistence, queues, frameworks, or applications.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/node-sdk/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/apps/**',
                '@nestjs/*',
                '@pertexo/api',
                '@pertexo/api/*',
                '@pertexo/worker',
                '@pertexo/worker/*',
                '@pertexo/artifact-store',
                '@pertexo/artifact-store/*',
                '@pertexo/database',
                '@pertexo/database/*',
                '@pertexo/observability',
                '@pertexo/observability/*',
                '@pertexo/queue',
                '@pertexo/queue/*',
                '@pertexo/workflow-model',
                '@pertexo/workflow-model/*',
                '@pertexo/nodes-core',
                '@pertexo/nodes-core/*',
                'bullmq',
                'drizzle-orm',
                'ioredis',
                'pg',
              ],
              message:
                'The node SDK owns portable node contracts and cannot depend on infrastructure, graph runtime, or core implementations.',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      'packages/node-sdk/src/index.ts',
      'packages/node-sdk/src/definitions/catalog.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/apps/**',
                '@nestjs/*',
                '@pertexo/api',
                '@pertexo/api/*',
                '@pertexo/worker',
                '@pertexo/worker/*',
                '@pertexo/artifact-store',
                '@pertexo/artifact-store/*',
                '@pertexo/database',
                '@pertexo/database/*',
                '@pertexo/observability',
                '@pertexo/observability/*',
                '@pertexo/queue',
                '@pertexo/queue/*',
                '@pertexo/workflow-model',
                '@pertexo/workflow-model/*',
                '@pertexo/nodes-core',
                '@pertexo/nodes-core/*',
                'bullmq',
                'drizzle-orm',
                'ioredis',
                'pg',
              ],
              message:
                'The node SDK browser entry cannot depend on infrastructure, graph runtime, or core implementations.',
            },
            {
              group: ['node:*', './server', './server.js'],
              message:
                'The node SDK browser entry cannot import Node builtins or server-only implementation modules.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/nodes-core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/apps/**',
                '@nestjs/*',
                '@pertexo/api',
                '@pertexo/api/*',
                '@pertexo/worker',
                '@pertexo/worker/*',
                '@pertexo/artifact-store',
                '@pertexo/artifact-store/*',
                '@pertexo/database',
                '@pertexo/database/*',
                '@pertexo/observability',
                '@pertexo/observability/*',
                '@pertexo/queue',
                '@pertexo/queue/*',
                'bullmq',
                'drizzle-orm',
                'ioredis',
                'pg',
              ],
              message:
                'Core nodes own pure definitions and executors, not application infrastructure or providers.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/execution/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@pertexo/database',
              message:
                'Import a database area entry point, such as @pertexo/database/runs.',
            },
          ],
          patterns: [
            {
              group: [
                '**/apps/**',
                '@nestjs/*',
                '@pertexo/api',
                '@pertexo/api/*',
                '@pertexo/worker',
                '@pertexo/worker/*',
                '@pertexo/queue',
                '@pertexo/queue/*',
                'bullmq',
                'ioredis',
                'pg',
              ],
              message:
                'Execution holds run actions; transactions, queues and transport belong to the database package and the apps.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/workflow-engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/apps/**',
                '@nestjs/*',
                '@pertexo/api',
                '@pertexo/api/*',
                '@pertexo/artifact-store',
                '@pertexo/artifact-store/*',
                '@pertexo/database',
                '@pertexo/database/*',
                '@pertexo/observability',
                '@pertexo/observability/*',
                '@pertexo/queue',
                '@pertexo/queue/*',
                '@pertexo/worker',
                '@pertexo/worker/*',
                '@pertexo/nodes-core',
                '@pertexo/nodes-core/*',
                'bullmq',
                'drizzle-orm',
                'ioredis',
              ],
              message:
                'Workflow model and engine packages own pure deterministic policy and cannot depend on persistence, transport, frameworks, observability, artifacts, or applications.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/workflow-model/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [workflowModelLayer],
        },
      ],
    },
  },
  {
    // The browser entry (src/index.ts) and everything it reaches stay free
    // of Node; checksums, expressions and authoring validation are server-only.
    files: ['packages/workflow-model/src/**/*.ts'],
    ignores: [
      'packages/workflow-model/src/server.ts',
      'packages/workflow-model/src/graph/identity.ts',
      'packages/workflow-model/src/triggers/event-coordination/key.ts',
      'packages/workflow-model/src/values/expressions/**',
      'packages/workflow-model/src/authoring/validation/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            workflowModelLayer,
            {
              group: [
                'node:*',
                'jsonata',
                './server.js',
                '**/graph/identity.js',
                '**/event-coordination/key.js',
                '**/expressions/*',
                '**/authoring/validation/*',
              ],
              allowTypeImports: true,
              message:
                'Browser-safe workflow-model code cannot import Node or server-only modules; export Node-only code from src/server.ts.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/api/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@pertexo/database',
              message:
                'Import a database area entry point, such as @pertexo/database/runs.',
            },
          ],
          patterns: [
            {
              group: [
                '**/apps/worker/**',
                '@pertexo/worker',
                '@pertexo/worker/*',
              ],
              message:
                'The API cannot import worker consumers or runtime code.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/worker/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@pertexo/database',
              message:
                'Import a database area entry point, such as @pertexo/database/runs.',
            },
          ],
          patterns: [
            {
              group: ['**/apps/api/**', '@pertexo/api', '@pertexo/api/*'],
              message:
                'The worker cannot import API controllers or runtime code.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/api/test/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/apps/worker/**',
                '@pertexo/worker',
                '@pertexo/worker/*',
              ],
              message:
                'The API cannot import worker consumers or runtime code.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/worker/test/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/apps/api/**', '@pertexo/api', '@pertexo/api/*'],
              message:
                'The worker cannot import API controllers or runtime code.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/ops/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@pertexo/database',
              message:
                'Import a database area entry point, such as @pertexo/database/runs.',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      ...readableWorkspaces.map((workspace) => `${workspace}/**/*.{ts,tsx}`),
      'apps/web/src/**/*.{ts,tsx}',
    ],
    rules: readabilityRules,
  },
  {
    files: readableWorkspaces.map(
      (workspace) => `${workspace}/test/**/*.{ts,tsx}`,
    ),
    rules: { 'max-lines-per-function': 'off' },
  },
  {
    // Declarative protocol, schema, retention and OpenAPI tables stay together,
    // as does the workflow-model entry point, which only lists its exports.
    files: [
      'packages/workflow-model/src/index.ts',
      'packages/database/src/schema/foundation.ts',
      'packages/database/src/schema/runs/execution.ts',
      'packages/contracts/src/errors/api-problem.ts',
      'packages/contracts/src/openapi/connections.ts',
      'packages/contracts/src/openapi/execution/runs.ts',
      'packages/contracts/src/openapi/identity/workspaces.ts',
      'packages/contracts/src/openapi/workflows/authoring.ts',
      'packages/contracts/src/openapi/workflows/organization.ts',
      'packages/contracts/src/schemas/connections.ts',
      'packages/contracts/src/schemas/execution/runs.ts',
    ],
    rules: { 'max-lines': 'off' },
  },
  {
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: nodeGlobals,
    },
  },
);
