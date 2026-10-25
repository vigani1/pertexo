import { PlugIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  requiredConnections,
  StepTile,
} from '@/features/catalog/presentation.public';
import { STEP_DRAG_TYPE, type StepChoice } from '../../model/step-catalog';

/** The shape every add-step row shares: a tile, its words and a trailing mark. */
export const stepRowClass =
  'group flex min-h-11 w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left outline-none hover:bg-surface-ink/5 focus-visible:bg-surface-ink/5 focus-ring';

/** Reserve two description lines so browsing keeps a steady row rhythm. */
export function StepRowText({
  name,
  description,
  children,
}: Readonly<{ name: string; description: string; children?: ReactNode }>) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-[0.82rem] font-medium">{name}</span>
      <span className="block line-clamp-2 min-h-[2lh] text-[0.72rem] leading-snug text-subtle-foreground">
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
  const needsConnection = requiredConnections(definition).length > 0;
  return (
    <button
      type="button"
      draggable
      // Longer descriptions remain available in the native tooltip.
      title={
        needsConnection
          ? `${step.description}. Needs a connection.`
          : step.description
      }
      // Skipped rows keep a row's height, so the list doesn't jump as they draw.
      className={`${stepRowClass} [contain-intrinsic-size:auto_2.25rem] [content-visibility:auto]`}
      onDragStart={(event) => {
        event.dataTransfer.setData(STEP_DRAG_TYPE, choice.identity);
        event.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => {
        onAdd(choice);
      }}
    >
      <StepTile step={step} size="sm" />
      <StepRowText name={step.name} description={step.description} />
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
