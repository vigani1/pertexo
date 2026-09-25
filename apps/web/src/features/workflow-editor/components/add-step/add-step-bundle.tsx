import { ChevronDownIcon, WaypointsIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { StepTile } from '@/features/catalog/presentation.public';
import { cn } from '@/lib/utils';
import type { StepChoice, StepChoiceBundle } from '../../model/step-catalog';
import { AddStepItem, StepRowText, stepRowClass } from './add-step-item';

const bundleTile = { family: 'logic', icon: WaypointsIcon } as const;

/**
 * "Switch · Parallel · Merge": one row that opens in place to its steps, so
 * the list stays short while each step is one more press away. A search
 * lists them on their own instead.
 */
export function AddStepBundle({
  bundle,
  onAdd,
}: Readonly<{
  bundle: StepChoiceBundle;
  onAdd: (choice: StepChoice) => void;
}>) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        className={stepRowClass}
        onClick={() => {
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' && !open) setOpen(true);
          else if (event.key === 'ArrowLeft' && open) setOpen(false);
        }}
      >
        <StepTile step={bundleTile} size="sm" />
        <StepRowText name={bundle.name} description={bundle.description} />
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 text-subtle-foreground transition-transform duration-150 motion-reduce:transition-none',
            open && 'rotate-180',
          )}
        />
      </button>
      <ul
        id={listId}
        hidden={!open}
        aria-label={bundle.name}
        className="mt-0.5 ml-4.5 flex flex-col border-l border-white/8 pl-1.5"
      >
        {bundle.choices.map((choice) => (
          <li key={choice.identity}>
            <AddStepItem choice={choice} onAdd={onAdd} />
          </li>
        ))}
      </ul>
    </>
  );
}
