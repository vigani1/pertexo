import type { AccessibleWorkspace } from '@pertexo/contracts';
import { Link } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { ROLE_MATRIX } from '../../model/workspace-roles';

/**
 * What the person can do here: every ability as a chip with a lit bead
 * where they hold it, the same beads as the roles table on Team.
 */
export function WorkspaceAccess({
  workspace,
}: Readonly<{ workspace: AccessibleWorkspace }>) {
  const granted = new Set<string>(workspace.capabilities);
  const canSeeTeam = granted.has('member:read');
  const allowedCount = ROLE_MATRIX.filter((row) =>
    row.capabilities.every((capability) => granted.has(capability)),
  ).length;
  return (
    <div className="flex flex-col gap-3">
      <p className="font-mono text-xs text-subtle-foreground">
        {allowedCount} of {ROLE_MATRIX.length} abilities
      </p>
      {/* Every ability as a chip, lit where you hold it: the whole set
          reads at a glance instead of as a long list. */}
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {ROLE_MATRIX.map((row) => {
          // What this workspace grants now, which can be less than the
          // role's name promises (a workspace pending deletion, say).
          const allowed = row.capabilities.every((capability) =>
            granted.has(capability),
          );
          return (
            <li
              key={row.ability}
              className={cn(
                'flex min-w-0 items-center gap-2.5 rounded-md border px-2.5 py-2 text-[0.8rem] leading-snug',
                allowed
                  ? 'border-action/20 bg-action/[0.05]'
                  : 'border-surface-ink/6 bg-transparent',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'size-2 shrink-0 rounded-full',
                  allowed
                    ? 'bg-action'
                    : 'border border-surface-ink/18 bg-card',
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
