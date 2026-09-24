import { PlugIcon } from 'lucide-react';
import { StepTile } from '@/features/catalog/presentation.public';
import { cn } from '@/lib/utils';
import { STEP_DRAG_TYPE, type StepChoice } from '../../model/step-catalog';

const lifecycleWords = {
  deprecated: 'Deprecated',
  migration_required: 'Needs migration',
} as const;

/** One placeable step: click to drop it in view, or drag it onto the canvas. */
export function AddStepItem({
  choice,
  onAdd,
}: Readonly<{ choice: StepChoice; onAdd: (choice: StepChoice) => void }>) {
  const { definition, step } = choice;
  const needsConnection = definition.connectionRequirements.length > 0;
  const lifecycle =
    definition.lifecycle === 'deprecated' ||
    definition.lifecycle === 'migration_required'
      ? lifecycleWords[definition.lifecycle]
      : undefined;
  return (
    <button
      type="button"
      draggable
      className={cn(
        'group flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left outline-none [content-visibility:auto]',
        'hover:bg-white/5 focus-visible:bg-white/5 focus-visible:ring-2 focus-visible:ring-ring/60',
      )}
      onDragStart={(event) => {
        event.dataTransfer.setData(STEP_DRAG_TYPE, choice.identity);
        event.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => {
        onAdd(choice);
      }}
    >
      <StepTile step={step} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.82rem] font-medium">
          {step.name}
        </span>
        <span className="block truncate text-[0.72rem] leading-snug text-subtle-foreground">
          {step.description}
        </span>
        {lifecycle === undefined ? null : (
          <span className="mt-0.5 block font-mono text-[0.62rem] text-warning">
            {lifecycle}
          </span>
        )}
      </span>
      {needsConnection ? (
        <PlugIcon
          aria-label="Needs a connection"
          role="img"
          className="size-3.5 shrink-0 text-subtle-foreground"
        />
      ) : null}
    </button>
  );
}
