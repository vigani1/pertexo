import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Notice } from '@/components/ui/notice';
import { Button } from '@/components/ui/button';
import type { ApiClient } from '@/lib/api/client';
import { workflowRunVariablesQueryOptions } from '../../data/stored-values.queries';
type Scope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  runId: string;
}>;
export function RunVariables({ scope }: Readonly<{ scope: Scope }>) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="border-y border-border py-3"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary className="cursor-pointer rounded text-sm outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">
        Workspace variables for this run
      </summary>
      {open ? <CapturedVariables scope={scope} /> : null}
    </details>
  );
}
function CapturedVariables({ scope }: Readonly<{ scope: Scope }>) {
  const query = useQuery(
    workflowRunVariablesQueryOptions(
      scope.apiClient,
      scope.userId,
      scope.workspaceId,
      scope.runId,
    ),
  );
  if (query.isPending)
    return (
      <p role="status" className="py-3 text-sm text-muted-foreground">
        Loading captured values…
      </p>
    );
  if (query.isError)
    return (
      <Notice
        action={
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void query.refetch()}
          >
            Try again
          </Button>
        }
      >
        This run’s variables could not be loaded.
      </Notice>
    );
  const snapshot = query.data.snapshot;
  if (snapshot === null)
    return (
      <p className="py-3 text-sm text-muted-foreground">
        This run’s variable snapshot expired with its execution details. Start a
        new run to use current values.
      </p>
    );
  return (
    <div className="pt-3">
      <p className="text-sm text-muted-foreground">
        Captured revision {snapshot.revision}. Replay, recovery and child
        workflows keep these values.
      </p>
      {Object.keys(snapshot.values).length === 0 ? (
        <p className="mt-2 text-sm">No workspace variables were configured.</p>
      ) : (
        <dl className="mt-2 divide-y divide-border">
          {Object.entries(snapshot.values).map(([name, value]) => (
            <div
              key={name}
              className="flex min-w-0 flex-col gap-1 py-2 text-sm sm:flex-row sm:gap-6"
            >
              <dt className="font-mono">{name}</dt>
              <dd className="break-words whitespace-pre-wrap">
                {String(value)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
