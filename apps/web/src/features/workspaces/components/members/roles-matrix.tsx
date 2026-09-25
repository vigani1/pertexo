import { cn } from '@/lib/utils';
import {
  ROLE_MATRIX,
  ROLE_NAMES,
  ROLE_SHORT_NAMES,
  WORKSPACE_ROLES,
  withArticle,
  type WorkspaceRole,
} from '../../model/workspace-roles';

/**
 * What each role can do, drawn as a woven grid: every ability is a thread
 * across the roles, tied with a lit bead where the role holds it.
 */
export function RolesMatrix({
  yourRole,
  className,
}: Readonly<{ yourRole: WorkspaceRole; className?: string }>) {
  return (
    <section
      aria-labelledby="roles-matrix-title"
      className={cn(
        'rounded-xl border border-border bg-card/40 p-4',
        className,
      )}
    >
      <h2 id="roles-matrix-title" className="text-base font-semibold">
        What each role can do
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        You’re {withArticle(yourRole)}. Your column is highlighted.
      </p>
      <table className="mt-4 w-full border-collapse text-xs">
        <thead>
          <tr>
            <th scope="col" className="sr-only">
              Ability
            </th>
            {WORKSPACE_ROLES.map((role) => (
              <th
                key={role}
                scope="col"
                className={cn(
                  'w-10 px-0.5 pb-2 text-center text-[0.68rem] font-semibold text-subtle-foreground sm:w-14',
                  role === yourRole && 'text-accent-foreground',
                )}
              >
                <span aria-hidden="true" className="sm:hidden">
                  {ROLE_SHORT_NAMES[role]}
                </span>
                <span className="max-sm:sr-only">{ROLE_NAMES[role]}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROLE_MATRIX.map((row) => (
            <tr key={row.ability} className="border-t border-border">
              <th
                scope="row"
                className="py-2 pr-2 text-left font-normal text-muted-foreground"
              >
                {row.ability}
              </th>
              {WORKSPACE_ROLES.map((role) => {
                const allowed = row.roles.includes(role);
                return (
                  <td
                    key={role}
                    className={cn(
                      'relative h-8 text-center',
                      "before:absolute before:inset-x-0 before:top-1/2 before:h-px before:bg-white/6 before:content-['']",
                      role === yourRole && 'bg-primary/5',
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'relative inline-block size-2.5 rounded-full',
                        allowed
                          ? 'bg-primary shadow-[0_0_8px_color-mix(in_srgb,var(--primary)_70%,transparent)]'
                          : 'border border-white/18 bg-card',
                      )}
                    />
                    <span className="sr-only">{allowed ? 'Yes' : 'No'}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
