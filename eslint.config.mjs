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
    files: ['packages/database/**/*.ts'],
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
      'packages/node-sdk/src/catalog.ts',
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
              group: ['node:*', './server', './server.js', './server-only.js'],
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
      'packages/workflow-model/src/expressions/**',
      'packages/workflow-model/src/authoring-validation/**',
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
                '**/expressions/*',
                '**/authoring-validation/*',
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
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: nodeGlobals,
    },
  },
);
