import { Fragment } from 'react';
import { cn } from '@/lib/utils';
import {
  ROLE_MATRIX,
  ROLE_NAMES,
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
                  'px-0.5 pb-2 text-center max-sm:w-1/5 text-[0.62rem] font-semibold text-subtle-foreground sm:w-20 sm:text-[0.7rem]',
                  role === yourRole && 'text-accent-foreground',
                )}
              >
                {ROLE_NAMES[role]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROLE_MATRIX.map((row) => (
            <Fragment key={row.ability}>
              {/* Phones: the ability gets a line of its own above its beads,
                  instead of wrapping four lines deep beside them. The row
                  header below still names the row for screen readers. */}
              <tr
                aria-hidden="true"
                className="border-t border-border sm:hidden"
              >
                <td
                  colSpan={WORKSPACE_ROLES.length + 1}
                  className="pt-2 text-muted-foreground"
                >
                  {row.ability}
                </td>
              </tr>
              <tr className="sm:border-t sm:border-border">
                <th
                  scope="row"
                  className="py-2 pr-2 text-left font-normal text-muted-foreground max-sm:sr-only"
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
                          // Your column's beads are lit; the others are
                          // softer, so the grid isn't the brightest thing here.
                          allowed
                            ? role === yourRole
                              ? 'bg-action'
                              : 'bg-action/45'
                            : 'border border-white/18 bg-card',
                        )}
                      />
                      <span className="sr-only">{allowed ? 'Yes' : 'No'}</span>
                    </td>
                  );
                })}
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>
    </section>
  );
}
