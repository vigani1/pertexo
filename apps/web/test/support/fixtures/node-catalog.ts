import {
  connectionFormCatalog,
  platformBrowserNodeDefinitionCatalog,
} from '@pertexo/node-catalog';
import { catalogStepDescriptions } from '@/features/catalog/public';
import { nodeDefinitionListResponseSchema } from '@pertexo/contracts';

/** The catalog through the same JSON contract consumed by browser graph commands. */
export function browserDefinitions() {
  return nodeDefinitionListResponseSchema.parse({
    items: platformBrowserNodeDefinitionCatalog().definitions,
  }).items;
}

export const describeBrowserStep =
  catalogStepDescriptions(browserDefinitions());

export const browserConnectionDefinitions =
  nodeDefinitionListResponseSchema.parse({
    items: [],
    connections: connectionFormCatalog(),
  }).connections ?? [];
