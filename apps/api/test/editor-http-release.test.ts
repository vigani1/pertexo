import { expect, it } from 'vitest';
import {
  platformBrowserNodeDefinitionCatalog,
  platformServingRegistryRelease,
} from '@pertexo/node-catalog';
import {
  composeExecutableCompatibilityRelease,
  describeExecutableCompatibilityRelease,
} from '@pertexo/workflow-engine';

it('the HTTP gate uses one cohort while respecting distinct browser and executable fingerprints', () => {
  const catalog = platformBrowserNodeDefinitionCatalog();
  const executable = describeExecutableCompatibilityRelease(
    composeExecutableCompatibilityRelease(platformServingRegistryRelease()),
  );
  expect(catalog.release.epoch).toBe(executable.epoch);
  expect(catalog.release.fingerprint).not.toBe(executable.fingerprint);
  for (const key of [
    'core.webhook',
    'core.validate',
    'core.set',
    'core.condition',
    'http.request',
  ])
    expect(
      catalog.definitions.find(
        ({ definition }) => definition.key === key && definition.version === 1,
      ),
    ).toMatchObject({ available: true, publishable: true });
});
