import { PlusIcon } from 'lucide-react';
import { CoreOrb } from '@/components/patterns/core/orb';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { ExampleCards } from '../templates/example-cards';

/**
 * An empty workspace: the Core and an invitation to weave the first
 * workflow, blank or from one of the ready-made examples.
 */
export function WorkflowListEmpty({
  canCreate,
  onStartBlank,
  onChooseExample,
}: Readonly<{
  canCreate: boolean;
  onStartBlank: () => void;
  onChooseExample: (templateId: string) => void;
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
          and runs its steps in order. Start blank, or from an example.
        </EmptyDescription>
        <div className="mt-3">
          <ExampleCards layout="cards" onChoose={onChooseExample} />
        </div>
        <EmptyActions>
          <Button type="button" variant="primary" onClick={onStartBlank}>
            <PlusIcon aria-hidden="true" data-icon="inline-start" />
            New workflow
          </Button>
        </EmptyActions>
      </div>
    </section>
  );
}
