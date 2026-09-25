import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import type { GraphLevel } from '../../../model/graph-scopes';
import type {
  InputMappingDraftRow,
  SchemaValueType,
} from '../../../model/input-mappings';
import {
  describeMappingSource,
  type MappingSourceTone,
} from '../../../model/mapping-summary';

const chipVariants = cva(
  'inline-block max-w-full min-w-0 shrink truncate rounded-sm px-1.5 py-1 font-mono text-[0.66rem] leading-none font-semibold',
  {
    variants: {
      tone: {
        reference: 'bg-accent text-accent-foreground',
        code: 'bg-secondary/10 text-secondary',
        value: 'bg-white/6 text-muted-foreground',
        missing:
          'text-subtle-foreground shadow-[inset_0_0_0_1px_var(--border-strong)]',
      } satisfies Record<MappingSourceTone, string>,
    },
  },
);

/**
 * One input at a glance: `field ← source` with the value type on the right,
 * and an expression's code under it. It is the disclosure button for the
 * row's editor, so its words are also its accessible name.
 */
export function MappingSummary({
  row,
  graph,
  type,
  open,
  controlsId,
  describedBy,
  onToggle,
}: Readonly<{
  row: InputMappingDraftRow;
  /** The level the step is on, to name the step a row reads from. */
  graph: GraphLevel;
  type: SchemaValueType | undefined;
  open: boolean;
  controlsId: string;
  describedBy: string | undefined;
  onToggle: () => void;
}>) {
  const source = describeMappingSource(row, graph);
  const unnamed = row.destinationKey.trim() === '';
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controlsId}
      aria-describedby={describedBy}
      className="-m-1.5 flex w-[calc(100%+0.75rem)] flex-col gap-2.5 rounded-md p-1.5 text-left outline-none hover:bg-white/3 focus-visible:ring-2 focus-visible:ring-ring/60"
      onClick={onToggle}
    >
      {/* Spaces between the parts keep the accessible name readable:
          "amount from New invoice › body.amount number". */}
      <span className="flex w-full min-w-0 items-center gap-2 text-[0.8rem]">
        <span
          className={cn(
            'max-w-[45%] min-w-0 shrink-0 truncate font-semibold',
            unnamed && 'font-normal text-subtle-foreground italic',
          )}
        >
          {unnamed ? 'Unnamed input' : row.destinationKey}
        </span>{' '}
        <span aria-hidden="true" className="text-subtle-foreground">
          ←
        </span>
        <span className="sr-only">from</span>{' '}
        <span className={chipVariants({ tone: source.tone })}>
          {source.label}
        </span>
        {type === undefined ? null : (
          <>
            {' '}
            <span className="ml-auto shrink-0 pl-1 font-mono text-[0.66rem] text-subtle-foreground">
              {type}
            </span>
          </>
        )}
      </span>
      {source.code === undefined || open ? null : (
        <>
          {' '}
          <code className="block w-full rounded-md border border-primary/28 bg-black/30 px-2.5 py-2 font-mono text-[0.78rem] break-words whitespace-pre-wrap text-foreground">
            {source.code}
          </code>
        </>
      )}
    </button>
  );
}
