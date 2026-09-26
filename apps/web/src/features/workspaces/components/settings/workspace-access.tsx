import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { ROLE_MATRIX } from '../../model/workspace-roles';

/**
 * What the person can do here: every ability as a thread with a lit bead
 * where they hold it, the same beads as the roles table on Team.
 */
export function WorkspaceAccess({
  workspace,
}: Readonly<{ workspace: AccessibleWorkspace }>) {
  const granted = new Set<string>(workspace.capabilities);
  const canSeeTeam = granted.has('member:read');
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col">
        {ROLE_MATRIX.map((row) => {
          // What this workspace grants now, which can be less than the
          // role's name promises (a workspace pending deletion, say).
          const allowed = row.capabilities.every((capability) =>
            granted.has(capability),
          );
          return (
            <li
              key={row.ability}
              className="flex items-center gap-3 border-t border-border py-2.5 text-sm first:border-t-0"
            >
              <span
                aria-hidden="true"
                className={cn(
                  'size-2.5 shrink-0 rounded-full',
                  allowed ? 'bg-action' : 'border border-white/18 bg-card',
                )}
              />
              <span className={allowed ? undefined : 'text-subtle-foreground'}>
                {row.ability}
              </span>
              <span className="sr-only">
                {allowed ? ': yes' : ': not with your role'}
              </span>
            </li>
          );
        })}
      </ul>
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
