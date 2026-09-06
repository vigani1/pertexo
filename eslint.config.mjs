import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

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
    },
  },
  {
    files: ['**/scripts/**/*.ts', '**/test/**/*.ts', '**/vitest*.config.ts'],
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
                'API production code must use the @pertexo/database/api capability surface.',
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
                'API production code must use the @pertexo/database/api capability surface.',
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
                'bullmq',
                'ioredis',
              ],
              message:
                'The database package is a server persistence leaf and cannot depend on frameworks, queues, observability, or applications.',
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
      'packages/node-sdk/src/release.ts',
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
                '@pertexo/workflow-engine',
                '@pertexo/workflow-engine/*',
                '@pertexo/node-sdk',
                '@pertexo/node-sdk/*',
                '@pertexo/nodes-core',
                '@pertexo/nodes-core/*',
                'bullmq',
                'drizzle-orm',
                'ioredis',
              ],
              message:
                'The workflow model is a lower-level deterministic contract and cannot depend on the engine or server infrastructure.',
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
                'API production code must use the @pertexo/database/api capability surface.',
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
            {
              group: [
                '@pertexo/database/execution',
                '@pertexo/database/lifecycle',
                '@pertexo/database/maintenance',
                '@pertexo/database/operator',
                '@pertexo/database/recovery',
              ],
              message:
                'API production code must use the @pertexo/database/api capability surface.',
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
                'Worker production code must use the @pertexo/database/execution capability surface.',
            },
          ],
          patterns: [
            {
              group: ['**/apps/api/**', '@pertexo/api', '@pertexo/api/*'],
              message:
                'The worker cannot import API controllers or runtime code.',
            },
            {
              group: [
                '@pertexo/database/api',
                '@pertexo/database/lifecycle',
                '@pertexo/database/maintenance',
                '@pertexo/database/operator',
                '@pertexo/database/recovery',
              ],
              message:
                'Worker production code must use the @pertexo/database/execution capability surface.',
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
  ...[
    ['apps/retention/src/**/*.ts', 'maintenance'],
    ['apps/recovery/src/**/*.ts', 'recovery'],
    ['apps/operator-command/src/**/*.ts', 'operator'],
    ['apps/lifecycle-command/src/**/*.ts', 'lifecycle'],
  ].map(([files, allowedSurface]) => ({
    files: [files],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@pertexo/database',
              message: `Production code in this runtime must use the @pertexo/database/${allowedSurface} capability surface.`,
            },
          ],
          patterns: [
            {
              group: [
                ...[
                  'api',
                  'execution',
                  'lifecycle',
                  'maintenance',
                  'operator',
                  'recovery',
                ]
                  .filter((surface) => surface !== allowedSurface)
                  .map((surface) => `@pertexo/database/${surface}`),
              ],
              message: `Production code in this runtime must use the @pertexo/database/${allowedSurface} capability surface.`,
            },
          ],
        },
      ],
    },
  })),
  {
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
);
