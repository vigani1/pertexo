import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import { BoxesIcon } from 'lucide-react';
import { NodeCategoryList } from './node-category-list';

const familyOrder = [
  'trigger',
  'action',
  'logic',
  'transform',
  'output',
] satisfies readonly NodeDefinitionCatalogItem['family'][];

export function NodePalette({
  definitions,
  onAdd,
}: Readonly<{
  definitions: readonly NodeDefinitionCatalogItem[];
  onAdd: (definition: NodeDefinitionCatalogItem) => void;
}>) {
  const available = definitions.filter((definition) => definition.available);
  return (
    <aside
      className="flex min-h-0 flex-col border-r border-white/8 bg-card/65 backdrop-blur-xl"
      aria-label="Node palette"
    >
      <div className="border-b border-white/8 p-3">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary shadow-[0_0_18px_rgb(0_229_255/10%)]">
            <BoxesIcon aria-hidden="true" className="size-4" />
          </span>
          <div>
            <h2 className="font-heading text-sm font-semibold">Node catalog</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Select a node to place it.
            </p>
          </div>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-3">
        {available.length === 0 ? (
          <p className="px-2 py-4 text-sm leading-relaxed text-muted-foreground">
            No definitions are available for placement.
          </p>
        ) : (
          familyOrder.map((family) => {
            const familyDefinitions = available.filter(
              (definition) => definition.family === family,
            );
            return familyDefinitions.length === 0 ? null : (
              <NodeCategoryList
                key={family}
                family={family}
                definitions={familyDefinitions}
                onAdd={onAdd}
              />
            );
          })
        )}
      </div>
    </aside>
  );
}
