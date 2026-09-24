import { PlusIcon } from 'lucide-react';
import { CoreOrb } from '@/components/patterns/core-orb';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  starterPreviewGraph,
  type AvailableStarter,
} from '../model/workflow-starters';
import { PatternGlyph } from './pattern-glyph';
import type { StartChoice } from './starter-choice';

/**
 * An empty workspace: the Core and an invitation to weave the first
 * workflow, with starters as large cards when they can be built here.
 */
export function WorkflowListEmpty({
  canCreate,
  starters,
  onStart,
}: Readonly<{
  canCreate: boolean;
  starters: readonly AvailableStarter[];
  onStart: (choice: StartChoice) => void;
}>) {
  if (!canCreate)
    return (
      <Empty>
        <EmptyTitle>No workflows yet</EmptyTitle>
        <EmptyDescription>
          Workflows appear here once someone who can build creates one. Ask a
          builder or an admin to set up the first.
        </EmptyDescription>
      </Empty>
    );
  return (
    <section
      aria-labelledby="workflows-empty-title"
      className="grid items-center gap-x-10 gap-y-6 border-t border-border py-10 lg:grid-cols-[16rem_minmax(0,1fr)]"
    >
      <EmptyMedia className="mx-auto">
        <CoreOrb state="idle" energy={0.45} assemble className="size-52" />
      </EmptyMedia>
      <div className="flex flex-col gap-3">
        <EmptyTitle id="workflows-empty-title" className="text-3xl">
          Weave your first workflow
        </EmptyTitle>
        <EmptyDescription>
          A workflow starts from a trigger — a webhook, a schedule or a click —
          and runs its steps in order. Start blank, or from a pattern.
        </EmptyDescription>
        {starters.length > 0 ? (
          <ul className="mt-3 grid gap-3 sm:grid-cols-3">
            {starters.map((starter) => (
              <li key={starter.id}>
                <button
                  type="button"
                  className="group/starter flex h-full w-full flex-col items-start gap-3 rounded-lg border border-border bg-white/[0.02] p-3 text-left transition-colors duration-150 outline-none hover:border-primary/35 hover:bg-primary/[0.04] focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none"
                  onClick={() => {
                    onStart(starter.id);
                  }}
                >
                  <span className="grid w-full place-items-center rounded-md bg-black/25 py-2">
                    <PatternGlyph
                      graph={starterPreviewGraph(starter)}
                      size="card"
                      flow="hover"
                    />
                  </span>
                  <span className="text-sm font-semibold text-foreground">
                    {starter.title}
                  </span>
                  <span className="text-xs leading-relaxed text-muted-foreground">
                    {starter.description}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <EmptyActions>
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              onStart('blank');
            }}
          >
            <PlusIcon aria-hidden="true" data-icon="inline-start" />
            New workflow
          </Button>
        </EmptyActions>
      </div>
    </section>
  );
}
