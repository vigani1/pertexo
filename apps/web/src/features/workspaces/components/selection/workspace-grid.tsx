import type { AccessibleWorkspace } from '@pertexo/contracts';
import { PlusIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Row, RowList } from '@/components/patterns/lists/row';
import { RuleHeading } from '@/components/patterns/lists/rule-heading';
import { WorkspaceCard } from './workspace-card';

/** Every workspace you belong to, then a tile to start another. */
export function WorkspaceGrid({
  workspaces,
  lastOpenedId,
  onSelect,
  onCreate,
}: Readonly<{
  workspaces: readonly AccessibleWorkspace[];
  lastOpenedId: string | undefined;
  onSelect: (workspace: AccessibleWorkspace) => void;
  onCreate: () => void;
}>) {
  return (
    <div className="flex min-w-0 flex-col gap-7">
      <header className="flex flex-col gap-3">
        <h1 className="font-display text-4xl leading-tight sm:text-hero">
          Pick up the thread.
        </h1>
        <p className="text-muted-foreground">Choose a workspace to continue.</p>
      </header>
      <section aria-labelledby="workspaces-title">
        <RuleHeading id="workspaces-title" count={workspaces.length}>
          Workspaces
        </RuleHeading>
        <RowList aria-label="Your workspaces" className="mt-2">
          {workspaces.map((workspace) => (
            <WorkspaceCard
              key={workspace.id}
              workspace={workspace}
              lastOpened={workspace.id === lastOpenedId}
              onSelect={onSelect}
            />
          ))}
          <Row className="grid-cols-[auto_minmax(0,1fr)] gap-x-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
            <span className="grid size-10 place-items-center rounded-lg border border-border text-muted-foreground">
              <PlusIcon aria-hidden="true" className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="font-semibold">Create a workspace</p>
              <p className="text-meta text-muted-foreground">
                Keep your team’s workflows, connections and runs together.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onCreate}
              className="col-start-2 justify-self-start sm:col-start-auto"
            >
              New workspace
            </Button>
          </Row>
        </RowList>
      </section>
      <p className="text-meta text-muted-foreground">
        Joining a team? Open the invite link from your email.
      </p>
    </div>
  );
}
