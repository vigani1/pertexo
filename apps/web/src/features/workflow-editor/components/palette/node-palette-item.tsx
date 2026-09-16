import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import { PlusIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function NodePaletteItem({
  definition,
  onAdd,
}: Readonly<{
  definition: NodeDefinitionCatalogItem;
  onAdd: (definition: NodeDefinitionCatalogItem) => void;
}>) {
  return (
    <Button
      type="button"
      variant="ghost"
      className="group h-auto w-full justify-start rounded-lg border border-transparent px-2.5 py-2.5 text-left hover:border-primary/20 hover:bg-primary/[0.06] [content-visibility:auto]"
      onClick={() => {
        onAdd(definition);
      }}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-primary/15 bg-primary/[0.07] text-primary transition-colors group-hover:border-primary/35">
        <PlusIcon aria-hidden="true" data-icon="inline-start" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {definition.definition.key}
        </span>
        <span className="mt-0.5 block font-mono text-[0.65rem] text-muted-foreground">
          version {definition.definition.version}
        </span>
      </span>
    </Button>
  );
}
