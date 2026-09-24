import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { PlusIcon } from 'lucide-react';
import {
  PageHeader,
  PageHeaderMeta,
  PageHeaderTitle,
} from '@/components/patterns/page-header';
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
  const count = workspaces.length;
  return (
    <section aria-labelledby="workspaces-title" className="flex flex-col gap-8">
      <PageHeader>
        <div>
          <PageHeaderTitle id="workspaces-title">Workspaces</PageHeaderTitle>
          <PageHeaderMeta>
            <span>
              {count} {count === 1 ? 'workspace' : 'workspaces'}
            </span>
          </PageHeaderMeta>
        </div>
      </PageHeader>
      <ul
        aria-label="Your workspaces"
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
      >
        {workspaces.map((workspace) => (
          <li key={workspace.id} className="min-w-0">
            <WorkspaceCard
              workspace={workspace}
              lastOpened={workspace.id === lastOpenedId}
              onSelect={onSelect}
            />
          </li>
        ))}
        <li className="min-w-0">
          <button
            type="button"
            onClick={onCreate}
            className="flex h-full min-h-44 w-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border-strong p-5 text-sm font-semibold text-muted-foreground transition-colors outline-none hover:border-primary/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none"
          >
            <span className="grid size-10 place-items-center rounded-full border border-primary/30 bg-primary/8 text-accent-foreground">
              <PlusIcon aria-hidden="true" className="size-4" />
            </span>
            New workspace
          </button>
        </li>
      </ul>
    </section>
  );
}
