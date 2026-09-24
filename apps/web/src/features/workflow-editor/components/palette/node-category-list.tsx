import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import { NodePaletteItem } from './node-palette-item';

export function NodeCategoryList({
  family,
  definitions,
  onAdd,
}: Readonly<{
  family: NodeDefinitionCatalogItem['family'];
  definitions: readonly NodeDefinitionCatalogItem[];
  onAdd: (definition: NodeDefinitionCatalogItem) => void;
}>) {
  return (
    <section aria-labelledby={`palette-${family}`}>
      <h3
        id={`palette-${family}`}
        className="px-2.5 font-mono text-xs font-semibold tracking-[0.14em] text-primary/75 uppercase"
      >
        {family}
      </h3>
      <div className="mt-1.5 flex flex-col gap-1">
        {definitions.map((definition) => (
          <NodePaletteItem
            key={`${definition.definition.key}@${String(definition.definition.version)}`}
            definition={definition}
            onAdd={onAdd}
          />
        ))}
      </div>
    </section>
  );
}
