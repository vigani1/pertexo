import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import rootConfig from '../../eslint.config.mjs';

export default tseslint.config(
  ...rootConfig,
  { ignores: ['playwright-report/**', 'test-results/**'] },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.test.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'error',
        {
          allowConstantExport: true,
          allowExportNames: ['buttonVariants'],
        },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:*',
                '@nestjs/*',
                '@pertexo/*',
                '**/packages/**',
                '**/apps/**',
              ],
              message:
                'Browser-only app. Add a reviewed browser-safe public contract subpath explicitly when wiring the API; never import backend runtime code.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/{components,lib}/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'node:*',
                '@nestjs/*',
                '@pertexo/*',
                '**/packages/**',
                '**/apps/**',
                '@/features/**',
                '@/app/**',
                '@/routes/**',
                '**/features/**',
                '**/app/**',
                '**/routes/**',
              ],
              message:
                'Shared UI and utilities cannot depend on application orchestration, features, or backend runtimes.',
            },
          ],
        },
      ],
    },
  },
);
