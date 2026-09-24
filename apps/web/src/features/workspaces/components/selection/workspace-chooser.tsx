import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { Button } from '@/components/ui/button';

const workspaceStatusCopy = Object.freeze({
  active: 'Ready',
  suspended: 'Suspended',
  pending_deletion: 'Deletion pending',
});

export function WorkspaceChooser({
  workspaces,
  onCreate,
  onSelect,
}: Readonly<{
  workspaces: readonly AccessibleWorkspace[];
  onCreate: () => void;
  onSelect: (workspace: AccessibleWorkspace) => void;
}>) {
  return (
    <section aria-labelledby="workspace-chooser-title">
      <div className="workspace-chooser-heading">
        <div>
          <h1
            id="workspace-chooser-title"
            className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl"
          >
            Workspaces
          </h1>
          <p className="mt-3 max-w-2xl leading-relaxed text-muted-foreground">
            Open a workspace to continue, or create another operational home.
          </p>
        </div>
        <Button type="button" variant="primary" onClick={onCreate}>
          Create workspace
        </Button>
      </div>

      <div aria-label="Available workspaces" className="workspace-list">
        {workspaces.map((workspace) => {
          const available =
            workspace.status === 'active' ||
            (workspace.status === 'pending_deletion' &&
              workspace.capabilities.includes('workspace:manage'));
          return (
            <button
              key={workspace.id}
              type="button"
              className="workspace-entry group"
              disabled={!available}
              aria-describedby={`workspace-${workspace.id}-detail`}
              onClick={() => {
                onSelect(workspace);
              }}
            >
              <span className="workspace-entry-index" aria-hidden="true">
                {workspace.name.slice(0, 2).toUpperCase()}
              </span>
              <span className="workspace-entry-identity min-w-0 flex-1 text-left">
                <span className="block [overflow-wrap:anywhere] font-heading text-xl font-semibold sm:truncate">
                  {workspace.name}
                </span>
                <span
                  id={`workspace-${workspace.id}-detail`}
                  className="mt-1 block [overflow-wrap:anywhere] text-sm text-muted-foreground sm:truncate"
                >
                  {workspace.slug} / {workspace.role}
                </span>
              </span>
              <span className="workspace-entry-status">
                {workspace.status === 'pending_deletion' && available
                  ? 'Open recovery'
                  : workspaceStatusCopy[workspace.status]}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
