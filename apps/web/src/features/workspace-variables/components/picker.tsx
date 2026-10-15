import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { variablesQueryOptions } from '../data/variables.queries';
import type { VariablesScope } from '../data/variables.api';
export function VariablePicker({
  scope,
  onChoose,
}: Readonly<{ scope: VariablesScope; onChoose: (name: string) => void }>) {
  const query = useQuery(variablesQueryOptions(scope));
  return (
    <>
      <p className="text-[0.8rem] font-semibold">Workspace variables</p>
      {query.isPending ? (
        <p className="py-1 text-xs text-muted-foreground">
          Loading variable names…
        </p>
      ) : query.isError ? (
        <p className="py-1 text-xs text-muted-foreground">
          Variable names could not be loaded.
        </p>
      ) : (
        <ul className="mt-1 ml-3 flex flex-col border-l border-white/8 pl-2">
          {Object.entries(query.data.values).map(([name, value]) => (
            <li key={name}>
              <button
                type="button"
                className="flex min-h-9 w-full items-center justify-between gap-2 rounded px-1 text-left text-[0.8rem] outline-offset-2 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                onClick={() => {
                  onChoose(name);
                }}
              >
                <code translate="no">$vars.{name}</code>
                <span className="text-xs text-muted-foreground">
                  {typeof value === 'boolean'
                    ? 'true/false'
                    : typeof value === 'number'
                      ? 'number'
                      : 'text'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-xs text-muted-foreground">
        Captured when the run starts.{' '}
        <Link
          to="/w/$workspaceId/settings/variables"
          params={{ workspaceId: scope.workspaceId }}
          className="text-action underline underline-offset-4"
        >
          Manage variables
        </Link>
      </p>
    </>
  );
}
