import type { WorkflowRunResponse } from '@pertexo/contracts/schemas/workflow-runs';
import { Link } from '@tanstack/react-router';
import { Status } from '@/components/ui/status';
import { describeRunStatus } from '../../model/run-status';
import { shortRunId } from '../../model/list/run-list';

/** Accepted run relationships, not an editable graph or another live-data owner. */
export function RunCallFamily({
  family,
  workspaceId,
}: Readonly<{
  family: NonNullable<WorkflowRunResponse['callFamily']>;
  workspaceId: string;
}>) {
  if (family.parentRunId === null && family.children.length === 0) return null;
  return (
    <section aria-label="Workflow calls" className="min-w-0 space-y-3 text-sm">
      {family.parentRunId !== null ? (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Link
            to="/w/$workspaceId/runs/$runId"
            params={{ workspaceId, runId: family.parentRunId }}
            className="text-accent-foreground underline underline-offset-4 focus-ring rounded-sm"
          >
            Parent run {shortRunId(family.parentRunId)}
          </Link>
          {family.rootRunId !== family.parentRunId ? (
            <Link
              to="/w/$workspaceId/runs/$runId"
              params={{ workspaceId, runId: family.rootRunId }}
              className="text-muted-foreground underline underline-offset-4 focus-ring rounded-sm"
            >
              Root run {shortRunId(family.rootRunId)}
            </Link>
          ) : null}
        </div>
      ) : null}
      {family.children.length > 0 ? (
        <div className="space-y-2">
          <h2 className="font-semibold">Called runs</h2>
          <ul className="space-y-2">
            {family.children.map((child) => {
              const look = describeRunStatus(child.status);
              return (
                <li
                  key={child.runId}
                  className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
                >
                  <Link
                    to="/w/$workspaceId/runs/$runId"
                    params={{ workspaceId, runId: child.runId }}
                    title={child.invocationKey}
                    className="min-w-0 break-all text-accent-foreground underline underline-offset-4 focus-ring rounded-sm"
                  >
                    {child.nodeId}: run {shortRunId(child.runId)}
                  </Link>
                  <Status tone={look.tone}>{look.label}</Status>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
