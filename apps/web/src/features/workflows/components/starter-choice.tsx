import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import {
  starterPreviewGraph,
  type AvailableStarter,
  type StarterId,
} from '../model/workflow-starters';
import { PatternGlyph } from './pattern-glyph';

export type StartChoice = StarterId | 'blank';

function BlankGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 132 48"
      width={132}
      height={48}
      className="block shrink-0"
    >
      <rect
        x={46}
        y={10}
        width={40}
        height={28}
        rx={6}
        strokeWidth={1}
        className="fill-none stroke-white/15 [stroke-dasharray:3_3]"
      />
      <path
        d="M66 19v10M61 24h10"
        strokeWidth={1.2}
        strokeLinecap="round"
        className="stroke-subtle-foreground"
      />
    </svg>
  );
}

function StarterOption({
  value,
  checked,
  disabled,
  title,
  description,
  glyph,
  onSelect,
}: Readonly<{
  value: StartChoice;
  checked: boolean;
  disabled: boolean;
  title: string;
  description: string;
  glyph: ReactNode;
  onSelect: (value: StartChoice) => void;
}>) {
  return (
    <label
      className={cn(
        'group/starter grid cursor-pointer grid-cols-[8.25rem_minmax(0,1fr)] items-center gap-3 rounded-lg border border-border bg-white/[0.02] p-2.5 transition-colors duration-150 hover:border-border-strong has-checked:border-primary/45 has-checked:bg-primary/[0.06] has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring has-disabled:cursor-not-allowed has-disabled:opacity-60 motion-reduce:transition-none',
      )}
    >
      <input
        type="radio"
        name="starter"
        value={value}
        checked={checked}
        disabled={disabled}
        className="sr-only"
        onChange={() => {
          onSelect(value);
        }}
      />
      <span className="grid place-items-center rounded-md bg-black/25 py-1">
        {glyph}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-foreground">
          {title}
        </span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
          {description}
        </span>
      </span>
    </label>
  );
}

/** "Start from": Blank or one of the starters this catalog can build. */
export function StarterChoice({
  starters,
  value,
  disabled,
  onChange,
}: Readonly<{
  starters: readonly AvailableStarter[];
  value: StartChoice;
  disabled: boolean;
  onChange: (value: StartChoice) => void;
}>) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">Start from</legend>
      <StarterOption
        value="blank"
        checked={value === 'blank'}
        disabled={disabled}
        title="Blank"
        description="An empty canvas. Add a trigger and steps in Build."
        glyph={<BlankGlyph />}
        onSelect={onChange}
      />
      {starters.map((starter) => (
        <StarterOption
          key={starter.id}
          value={starter.id}
          checked={value === starter.id}
          disabled={disabled}
          title={starter.title}
          description={starter.description}
          glyph={
            <PatternGlyph
              graph={starterPreviewGraph(starter)}
              size="card"
              flow={value === starter.id ? 'on' : 'hover'}
            />
          }
          onSelect={onChange}
        />
      ))}
    </fieldset>
  );
}
