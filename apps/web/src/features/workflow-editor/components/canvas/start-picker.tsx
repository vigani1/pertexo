import type { NodeDefinitionCatalogItem } from '@pertexo/contracts/schemas/catalog';
import { Button } from '@/components/ui/button';
import { describeStep, StepTile } from '@/features/catalog/presentation.public';
import { useEditorStore } from '../../model/editor-store-context';
import { definitionIdentity } from '../../model/graph-adapter';
import { isStartTrigger, placeableDefinitions } from '../../model/step-catalog';

/**
 * An empty draft starts with a trigger: Webhook, Schedule or Manual. When
 * this environment enables none, the card says so and offers the steps that
 * are available instead, so building never dead-ends here.
 */
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
  // One choice per step type, at the version a new step would use.
  const placeable = placeableDefinitions(definitions);
  const triggers = placeable.filter(isStartTrigger);
  const steps =
    triggers.length > 0
      ? []
      : placeable.filter((definition) => definition.family !== 'trigger');
  const copy = startCopy(editable, triggers.length > 0, steps.length > 0);
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center p-4">
      <section
        aria-labelledby="start-picker-title"
        className="lens pointer-events-auto flex max-h-[min(34rem,calc(100%-2rem))] w-full max-w-sm flex-col gap-4 rounded-xl p-5"
      >
        <div>
          <h2
            id="start-picker-title"
            className="font-heading text-lg font-semibold"
          >
            {copy.title}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{copy.body}</p>
        </div>
        {editable ? (
          <StartChoices
            label={triggers.length > 0 ? 'Triggers' : 'Available steps'}
            definitions={triggers.length > 0 ? triggers : steps}
            onPick={onPick}
          />
        ) : null}
      </section>
    </div>
  );
}

function startCopy(
  editable: boolean,
  hasTriggers: boolean,
  hasSteps: boolean,
): Readonly<{ title: string; body: string }> {
  if (!editable)
    return {
      title: 'No steps yet',
      body: 'This draft is empty. People who can edit it will add the first step.',
    };
  if (hasTriggers)
    return {
      title: 'Start with a trigger',
      body: 'A trigger decides when this workflow runs. You can change it later.',
    };
  return {
    title: 'No triggers are enabled here',
    body: hasSteps
      ? 'No triggers are enabled in this environment, so this workflow can’t start on its own yet. You can still build it with the steps that are available.'
      : 'No triggers or steps are enabled in this environment yet, so there’s nothing to add.',
  };
}

function StartChoices({
  label,
  definitions,
  onPick,
}: Readonly<{
  label: string;
  definitions: readonly NodeDefinitionCatalogItem[];
  onPick: (definition: NodeDefinitionCatalogItem) => void;
}>) {
  if (definitions.length === 0) return null;
  return (
    <ul
      aria-label={label}
      className="-mx-1 flex min-h-0 flex-col gap-1.5 overflow-y-auto px-1"
    >
      {definitions.map((definition) => {
        const step = describeStep(definition.definition.key, definition.family);
        return (
          <li
            key={definitionIdentity(
              definition.definition.key,
              definition.definition.version,
            )}
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
  );
}
