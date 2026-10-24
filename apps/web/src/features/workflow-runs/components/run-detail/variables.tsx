import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { WorkflowRunVariablesResponse } from '@pertexo/contracts';
import { QueryView } from '@/components/patterns/states/query-view';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Disclosure } from '@/components/ui/disclosure';
import { SkeletonLines } from '@/components/ui/skeleton';
import type { ApiClient } from '@/lib/api/client';
import { workflowRunVariablesQueryOptions } from '../../data/stored-values.queries';
// Enough to recognise the set; the rest wait behind "Show all".
const FIRST_TILES = 8;
type Scope = Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  runId: string;
}>;

/**
 * The workspace variables this run captured when it started, read only once
 * the fold opens. Each is a tile: its name, the value it had, and Copy.
 */
export function RunVariables({ scope }: Readonly<{ scope: Scope }>) {
  return (
    <Disclosure
      summary="Workspace variables this run used"
      lazy
      appearance={{ look: 'framed' }}
    >
      <CapturedVariables scope={scope} />
    </Disclosure>
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
  return (
    <QueryView
      query={query}
      resource="This run’s variables"
      loading={<SkeletonLines label="Loading captured values" lines={2} />}
    >
      {(data) => <VariableTiles captured={data} />}
    </QueryView>
  );
}

function VariableTiles({
  captured,
}: Readonly<{ captured: WorkflowRunVariablesResponse }>) {
  const [showAll, setShowAll] = useState(false);
  const snapshot = captured.snapshot;
  if (snapshot === null)
    return (
      <p className="text-sm text-muted-foreground">
        This run’s variable snapshot expired with its execution details. Start a
        new run to use current values.
      </p>
    );
  const entries = Object.entries(snapshot.values);
  const shown = showAll ? entries : entries.slice(0, FIRST_TILES);
  return (
    <div className="flex flex-col gap-3">
      {entries.length === 0 ? (
        <p className="text-sm">No workspace variables were configured.</p>
      ) : (
        <dl className="grid gap-2 sm:grid-cols-2">
          {shown.map(([name, value]) => {
            const text = String(value);
            return (
              <div
                key={name}
                className="group/variable flex min-w-0 items-start gap-2 rounded-md border border-surface-ink/6 bg-surface-ink/[0.02] px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <dt className="truncate font-mono text-xs text-subtle-foreground">
                    {name}
                  </dt>
                  <dd className="mt-1 font-mono text-sm break-all whitespace-pre-wrap text-foreground">
                    {text}
                  </dd>
                </div>
                <CopyButton
                  value={text}
                  label={`Copy ${name}`}
                  className="-mt-1 -mr-1.5 opacity-60 group-hover/variable:opacity-100 focus-visible:opacity-100"
                />
              </div>
            );
          })}
        </dl>
      )}
      {shown.length < entries.length ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-fit"
          onClick={() => {
            setShowAll(true);
          }}
        >
          Show all {entries.length}
        </Button>
      ) : null}
      <p className="text-xs text-subtle-foreground">
        Captured at revision {snapshot.revision} when the run started. Replays,
        recovery and child workflows keep these values.
      </p>
    </div>
  );
}
