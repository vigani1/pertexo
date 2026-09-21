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
              group: ['node:*', '@nestjs/*', '**/packages/**', '**/apps/**'],
              message:
                'Browser-only app. Add a reviewed browser-safe public contract subpath explicitly when wiring the API; never import backend runtime code.',
            },
            {
              regex:
                '^@pertexo/(?!(?:contracts/schemas/(?:artifacts|catalog|connections|errors|failure-notifications|identity-workspace|node-testing|schedules|transport|webhooks|workflow-authoring|workflow-runs)|workflow-model/json-path)$).+',
              message:
                'Import only an explicitly reviewed browser-safe contract schema subpath.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.type='Identifier'][callee.name='fetch']",
          message:
            'Use the injected API transport; raw fetch is restricted to reviewed transport adapters.',
        },
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.object.name=/^(globalThis|self|window)$/][callee.property.name='fetch']",
          message:
            'Use the injected API transport; raw fetch is restricted to reviewed transport adapters.',
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
            {
              regex: '^@pertexo/(?!contracts/schemas/(?:errors|transport)$).+',
              message:
                'Shared UI and utilities may import only reviewed browser-safe contract schema subpaths.',
            },
          ],
        },
      ],
    },
  },
);
