import type { AccessibleWorkspace } from '@pertexo/contracts';
import { heldCapabilities } from '../../model/workspace-availability';
import { Link } from '@tanstack/react-router';

export function WorkspaceAccess({
  workspace,
}: Readonly<{ workspace: AccessibleWorkspace }>) {
  const granted = new Set<string>(heldCapabilities(workspace));
  const canSeeTeam = granted.has('member:read');
  return (
    <div className="flex flex-col gap-3">
      {canSeeTeam ? (
        <p className="text-sm text-muted-foreground">
          <Link
            to="/w/$workspaceId/team"
            params={{ workspaceId: workspace.id }}
            className="inline-link"
          >
            Compare every role on Team
          </Link>
          , where roles are changed too.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Someone who manages members can change your role.
        </p>
      )}
    </div>
  );
}
