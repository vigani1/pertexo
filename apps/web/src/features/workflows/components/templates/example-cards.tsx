import {
  CURATED_WORKFLOW_TEMPLATES,
  FIRST_RUN_TEMPLATE_ID,
} from '@pertexo/templates';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { cn } from '@/lib/class-names';
import { PatternGlyph } from '../pattern-glyph';

const CARD =
  'group/pattern w-full rounded-lg border border-border bg-surface-ink/[0.02] text-left transition-colors duration-150 outline-none hover:border-primary/35 hover:bg-primary/[0.04] focus-ring disabled:pointer-events-none disabled:opacity-60 motion-reduce:transition-none';

// The example with nothing to set up leads: it's the quickest first success.
const ORDERED = [
  ...CURATED_WORKFLOW_TEMPLATES.filter(
    (template) => template.templateId === FIRST_RUN_TEMPLATE_ID,
  ),
  ...CURATED_WORKFLOW_TEMPLATES.filter(
    (template) => template.templateId !== FIRST_RUN_TEMPLATE_ID,
  ),
];

/**
 * The ready-made examples: the one list of ways to start other than blank, in
 * the New workflow sheet (`rows`) and an empty workspace (`cards`). An
 * example with nothing to set up opens straight in Build; the others open
 * their setup, which checks their steps against this workspace first.
 */
export function ExampleCards({
  layout,
  disabled = false,
  starting,
  onChoose,
}: Readonly<{
  layout: 'rows' | 'cards';
  disabled?: boolean;
  /** The example being created, which shows it's under way. */
  starting?: string | undefined;
  onChoose: (templateId: string) => void;
}>) {
  const cards = layout === 'cards';
  return (
    <ul
      className={cn(
        'grid gap-3',
        cards ? 'sm:grid-cols-2 xl:grid-cols-4' : 'gap-2',
      )}
    >
      {ORDERED.map((template) => {
        const busy = starting === template.templateId;
        return (
          <li key={template.templateId}>
            <button
              type="button"
              disabled={disabled || starting !== undefined}
              aria-busy={busy}
              aria-label={`Use this example: ${template.title}`}
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
                className="relative grid w-full place-items-center self-stretch rounded-md bg-recess-ink/25 py-2"
              >
                <PatternGlyph
                  graph={template.manifest.graph}
                  size="card"
                  flow={busy ? 'on' : 'hover'}
                />
              </span>
              <span className="flex min-w-0 flex-col gap-1">
                <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  {template.title}
                  {busy ? <LoadingOrb /> : null}
                </span>
                <span className="text-xs leading-relaxed text-muted-foreground">
                  {busy ? 'Setting it up…' : template.description}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
