import type { AccessibleWorkspace } from '@pertexo/contracts';
import { heldCapabilities } from '../../model/workspace-availability';
import { Link } from '@tanstack/react-router';
import { buttonVariants } from '@/components/ui/button-variants';

export function WorkspaceAccess({
  workspace,
}: Readonly<{ workspace: AccessibleWorkspace }>) {
  const granted = new Set<string>(heldCapabilities(workspace));
  const canSeeTeam = granted.has('member:read');
  return (
    <>
      {canSeeTeam ? (
        <Link
          to="/w/$workspaceId/team"
          params={{ workspaceId: workspace.id }}
          className={buttonVariants({ variant: 'ghost', size: 'sm' })}
        >
          Compare roles on Team
        </Link>
      ) : (
        <p className="max-w-48 text-meta text-subtle-foreground">
          Someone who manages members can change your role.
        </p>
      )}
    </>
  );
}
