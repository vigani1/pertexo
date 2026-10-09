import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import baseConfig from './vite.config.ts';
import { ownedBrowserQualificationBuild } from './test/support/owned-browser-build-qualification.ts';

export default defineConfig(({ mode }) => {
  if (
    !ownedBrowserQualificationBuild(mode, process.env, {
      mode: 'workflow-organization-qualification',
      scenario: 'workflow-organization',
    })
  )
    throw new Error(
      'Use the explicitly owned workflow organization qualification mode',
    );
  return {
    ...baseConfig,
    resolve: {
      ...baseConfig.resolve,
      alias: [
        {
          find: '@/features/workflows/model/organization/feature-gates',
          replacement: fileURLToPath(
            new URL(
              './e2e-live/support/workflow-organization-qualification-gates.ts',
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
