import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import { Button } from '@/components/ui/button';
import { useEditorStore } from '../../model/editor-store-context';
import { describeStep, StepTile } from '@/features/catalog/presentation.public';

/** An empty draft starts with a trigger: Webhook, Schedule or Manual. */
export function StartPicker({
  definitions,
  editable,
  onPick,
}: Readonly<{
  definitions: readonly NodeDefinitionCatalogItem[];
  editable: boolean;
  onPick: (definition: NodeDefinitionCatalogItem) => void;
}>) {
  const empty = useEditorStore((state) => state.graph.nodes.length === 0);
  if (!empty) return null;
  const triggers = definitions.filter(
    (definition) => definition.available && definition.family === 'trigger',
  );
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center p-4">
      <section
        aria-labelledby="start-picker-title"
        className="lens pointer-events-auto flex w-full max-w-sm flex-col gap-4 rounded-xl p-5"
      >
        <div>
          <h2
            id="start-picker-title"
            className="font-heading text-lg font-semibold"
          >
            {editable ? 'Start with a trigger' : 'No steps yet'}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {editable
              ? 'A trigger decides when this workflow runs. You can change it later.'
              : 'This draft is empty. People who can edit it will add the first step.'}
          </p>
        </div>
        {editable && triggers.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
            {triggers.map((definition) => {
              const step = describeStep(
                definition.definition.key,
                definition.family,
              );
              return (
                <li
                  key={`${definition.definition.key}@${String(definition.definition.version)}`}
                >
                  <Button
                    type="button"
                    variant="outline"
                    className="h-auto w-full justify-start gap-3 py-2.5 text-left"
                    onClick={() => {
                      onPick(definition);
                    }}
                  >
                    <StepTile step={step} />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-foreground">
                        {step.name}
                      </span>
                      <span className="block truncate text-xs font-normal text-subtle-foreground">
                        {step.description}
                      </span>
                    </span>
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
