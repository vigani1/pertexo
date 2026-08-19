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
    files: ['**/test/**/*.ts', '**/vitest*.config.ts'],
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
    files: ['apps/api/**/*.ts'],
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
    files: ['apps/worker/**/*.ts'],
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
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@pertexo/database',
                '@pertexo/artifact-store',
                '@pertexo/artifact-store/*',
                '@pertexo/observability',
                '@pertexo/observability/*',
                '@pertexo/queue',
                '@pertexo/queue/*',
                '@pertexo/*/server',
              ],
              message:
                'Browser code may import only browser-safe package exports.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
);
