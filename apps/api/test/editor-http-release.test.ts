import { expect, it } from 'vitest';
import {
  platformBrowserNodeDefinitionCatalog,
  platformServingRegistryRelease,
} from '@pertexo/node-catalog';
import {
  composeExecutableCompatibilityRelease,
  describeExecutableCompatibilityRelease,
} from '@pertexo/workflow-engine';
import { httpCohort } from './support/editor-http-evidence.js';

it('the HTTP gate uses one cohort while respecting distinct browser and executable fingerprints', () => {
  const catalog = platformBrowserNodeDefinitionCatalog(httpCohort);
  const executable = describeExecutableCompatibilityRelease(
    composeExecutableCompatibilityRelease(
      platformServingRegistryRelease(httpCohort),
    ),
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

it('rejects the older webhook cohort for the recipe because its Validate pin is unavailable', () => {
  const catalog = platformBrowserNodeDefinitionCatalog('webhook_activation');
  expect(catalog.release.epoch).toBe(22);
  expect(
    catalog.definitions.some(
      ({ definition, available, publishable }) =>
        definition.key === 'core.validate' &&
        definition.version === 1 &&
        available &&
        publishable,
    ),
  ).toBe(false);
  expect(platformBrowserNodeDefinitionCatalog(httpCohort).release.epoch).toBe(
    38,
  );
});
