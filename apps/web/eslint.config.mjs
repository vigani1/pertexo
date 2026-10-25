import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import rootConfig, { readabilityRules } from '../../eslint.config.mjs';

// Lazy code loads through one module, so a chunk that a deployment removed
// shows the update notice instead of reloading the page or crashing it.
const lazyLoadPaths = [
  {
    name: 'react',
    importNames: ['lazy'],
    message: 'Use lazyPiece from @/components/patterns/app-update/lazy.',
  },
  {
    name: '@tanstack/react-router',
    importNames: ['lazyRouteComponent'],
    message: 'Use lazyRoute from @/components/patterns/app-update/lazy.',
  },
];
const canonicalJsonOnly = {
  name: '@pertexo/workflow-model',
  allowImportNames: ['canonicalJson'],
  message: 'Shared transport may use canonical JSON, not workflow model APIs.',
};
const sharedLayerPatterns = [
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
    regex: '^@pertexo/(?!(?:contracts|workflow-model)$).+',
    message:
      'Shared UI and utilities may import browser-safe contracts and the explicitly allowed canonical JSON helper.',
  },
];

export default tseslint.config(
  ...rootConfig,
  // Root globs do not match paths relative to this local configuration.
  { files: ['src/**/*.{ts,tsx}'], rules: readabilityRules },
  {
    files: ['test/**/*.{ts,tsx}', 'e2e/**/*.ts', 'e2e-live/**/*.ts'],
    rules: {
      'max-params': ['error', 4],
      complexity: ['error', 20],
      'max-lines': ['error', 400],
    },
  },
  {
    files: [
      'test/**/*.{ts,tsx}',
      'e2e/**/*.ts',
      'e2e-live/**/*.ts',
      'playwright*.config.ts',
    ],
    rules: { 'no-nested-ternary': 'error' },
  },
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
          paths: lazyLoadPaths,
          patterns: [
            {
              group: ['node:*', '@nestjs/*', '**/packages/**', '**/apps/**'],
              message:
                'Browser-only app. Add a reviewed browser-safe public contract subpath explicitly when wiring the API; never import backend runtime code.',
            },
            {
              regex:
                '^@pertexo/(?!(?:contracts|workflow-model|templates|integrations|node-sdk)$).+',
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
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name='mutate'][arguments.length>1]",
          message:
            'TanStack Query drops mutate() callbacks once the caller unmounts. Await mutateAsync() and act after it, or put the effect in the mutation hook.',
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
          paths: [canonicalJsonOnly, ...lazyLoadPaths],
          patterns: sharedLayerPatterns,
        },
      ],
    },
  },
  {
    files: ['src/components/patterns/app-update/lazy.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [canonicalJsonOnly], patterns: sharedLayerPatterns },
      ],
    },
  },
  {
    files: ['src/features/artifacts/data/upload.api.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name='mutate'][arguments.length>1]",
          message: 'Await mutateAsync() so command feedback survives unmounts.',
        },
      ],
    },
  },
);
