import type { ReactNode } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { Link, useMatches } from '@tanstack/react-router';
import {
  shortRunId,
  workflowLabel,
} from '@/features/workflow-runs/run-labels.public';

/** What the run page's loader knows about its run, for the breadcrumb. */
export type RunCrumb = Readonly<{
  id: string;
  workflowId: string;
  workflowName: string | null;
}>;

/** One step of the workspace breadcrumb after the switcher. */
export type Crumb = Readonly<{ key: string; label: ReactNode }>;

type CrumbSource =
  | Readonly<{ kind: 'page'; label: string }>
  | Readonly<{ kind: 'run'; run: RunCrumb | undefined }>;

const crumbLinkClass =
  'rounded-sm outline-none hover:text-foreground focus-ring';

export function workflowsCrumb(workspaceId: string): Crumb {
  return {
    key: 'workflows',
    label: (
      <Link
        to="/w/$workspaceId/workflows"
        params={{ workspaceId }}
        className={crumbLinkClass}
      >
        Workflows
      </Link>
    ),
  };
}

/** "Runs / Invoice intake / 7f3a…0c21", each step leading back up. */
function runCrumbs(
  workspace: AccessibleWorkspace,
  run: RunCrumb | undefined,
): readonly Crumb[] {
  const runs: Crumb = {
    key: 'runs',
    label: (
      <Link
        to="/w/$workspaceId/runs"
        params={{ workspaceId: workspace.id }}
        className={crumbLinkClass}
      >
        Runs
      </Link>
    ),
  };
  if (run === undefined) return [runs];
  const name = workflowLabel(run);
  return [
    runs,
    {
      key: 'workflow',
      label: workspace.capabilities.includes('workflow:read') ? (
        <Link
          to="/w/$workspaceId/workflows/$workflowId"
          params={{ workspaceId: workspace.id, workflowId: run.workflowId }}
          className={crumbLinkClass}
        >
          {name}
        </Link>
      ) : (
        name
      ),
    },
    {
      key: 'run',
      label: <span className="font-mono">{shortRunId(run.id)}</span>,
    },
  ];
}

/**
 * The breadcrumb for the page on screen: each page's static name, or for a
 * run the trail back through Runs and its workflow.
 */
export function useShellCrumbs(
  workspace: AccessibleWorkspace,
): readonly Crumb[] {
  const sources = useMatches({
    select: (matches) =>
      matches.flatMap((match): CrumbSource[] => {
        if (match.routeId === '/w/$workspaceId/shell/runs/$runId')
          return [{ kind: 'run', run: match.loaderData?.run }];
        const label = match.staticData.crumb;
        return label === undefined || label === 'Home'
          ? []
          : [{ kind: 'page', label }];
      }),
    structuralSharing: true,
  });
  return sources.flatMap((source) =>
    source.kind === 'page'
      ? [{ key: source.label, label: source.label }]
      : runCrumbs(workspace, source.run),
  );
}
