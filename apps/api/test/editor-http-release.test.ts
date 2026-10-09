import { expect, it } from 'vitest';
import { platformBrowserNodeDefinitionCatalog } from '@pertexo/node-catalog';

it('the HTTP gate exposes every editor node as available and publishable', () => {
  const catalog = platformBrowserNodeDefinitionCatalog();
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
