import { PlugIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { StepTile } from '@/features/catalog/presentation.public';
import { STEP_DRAG_TYPE, type StepChoice } from '../../model/step-catalog';

const lifecycleWords = {
  deprecated: 'Deprecated',
  migration_required: 'Needs migration',
} as const;

/** The shape every add-step row shares: a tile, its words and a trailing mark. */
export const stepRowClass =
  'group flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left outline-none hover:bg-white/5 focus-visible:bg-white/5 focus-ring';

/** A row's name and one line about it, both cut to the row's width. */
export function StepRowText({
  name,
  description,
  children,
}: Readonly<{ name: string; description: string; children?: ReactNode }>) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-[0.82rem] font-medium">{name}</span>
      <span className="block truncate text-[0.72rem] leading-snug text-subtle-foreground">
        {description}
      </span>
      {children}
    </span>
  );
}

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
      className={`${stepRowClass} [content-visibility:auto]`}
      onDragStart={(event) => {
        event.dataTransfer.setData(STEP_DRAG_TYPE, choice.identity);
        event.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => {
        onAdd(choice);
      }}
    >
      <StepTile step={step} size="sm" />
      <StepRowText name={step.name} description={step.description}>
        {lifecycle === undefined ? null : (
          <span className="mt-0.5 block font-mono text-[0.62rem] text-warning">
            {lifecycle}
          </span>
        )}
      </StepRowText>
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
