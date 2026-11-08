import { platformBrowserNodeDefinitionCatalog } from '@pertexo/node-catalog';
import { nodeDefinitionListResponseSchema } from '@pertexo/contracts';

/** The catalog through the same JSON contract consumed by browser graph commands. */
export function browserDefinitions() {
  return nodeDefinitionListResponseSchema.parse({
    items: platformBrowserNodeDefinitionCatalog().definitions,
  }).items;
}
