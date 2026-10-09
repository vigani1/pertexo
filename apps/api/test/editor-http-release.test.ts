import { expect, it } from 'vitest';
import { platformBrowserNodeDefinitionCatalog } from '@pertexo/node-catalog';

it('the catalog lists every editor node', () => {
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
    ).toBeDefined();
});
