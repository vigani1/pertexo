import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import baseConfig from './vite.config.ts';
import { curatedTemplateQualificationBuild } from './test/support/curated-template-build-qualification.ts';

export default defineConfig(({ mode }) => {
  if (!curatedTemplateQualificationBuild(mode, process.env))
    throw new Error(
      'Use the explicitly owned curated-template qualification mode',
    );
  return {
    ...baseConfig,
    resolve: {
      ...baseConfig.resolve,
      alias: [
        {
          find: '@/features/workflows/model/template-feature-gates',
          replacement: fileURLToPath(
            new URL(
              './e2e-live/support/curated-template-qualification-gates.ts',
              import.meta.url,
            ),
          ),
        },
        {
          find: '@',
          replacement: fileURLToPath(new URL('./src', import.meta.url)),
        },
      ],
    },
  };
});
