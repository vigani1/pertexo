import { CURATED_WORKFLOW_TEMPLATES } from '@pertexo/templates';
import { cn } from '@/lib/utils';
import { PatternGlyph } from '../pattern-glyph';

const CARD =
  'group/pattern w-full rounded-lg border border-border bg-surface-ink/[0.02] text-left transition-colors duration-150 outline-none hover:border-primary/35 hover:bg-primary/[0.04] focus-ring disabled:pointer-events-none disabled:opacity-60 motion-reduce:transition-none';

/**
 * The ready-made examples: the one list of ways to start other than blank, in
 * the New workflow sheet (`rows`) and an empty workspace (`cards`). Choosing
 * one opens its setup, which checks its steps against this workspace before
 * anything is created.
 */
export function ExampleCards({
  layout,
  disabled = false,
  onChoose,
}: Readonly<{
  layout: 'rows' | 'cards';
  disabled?: boolean;
  onChoose: (templateId: string) => void;
}>) {
  const cards = layout === 'cards';
  return (
    <ul className={cn('grid gap-3', cards ? 'sm:grid-cols-3' : 'gap-2')}>
      {CURATED_WORKFLOW_TEMPLATES.map((template) => (
        <li key={template.templateId}>
          <button
            type="button"
            disabled={disabled}
            className={cn(
              CARD,
              cards
                ? 'flex h-full flex-col items-start gap-3 p-3'
                : 'grid grid-cols-[8.25rem_minmax(0,1fr)] items-center gap-3 p-2.5',
            )}
            onClick={() => {
              onChoose(template.templateId);
            }}
          >
            <span
              aria-hidden="true"
              className="grid w-full place-items-center self-stretch rounded-md bg-recess-ink/25 py-2"
            >
              <PatternGlyph
                graph={template.manifest.graph}
                size="card"
                flow="hover"
              />
            </span>
            <span className="flex min-w-0 flex-col gap-1">
              <span className="text-sm font-semibold text-foreground">
                {template.title}
              </span>
              <span className="text-xs leading-relaxed text-muted-foreground">
                {template.description}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
