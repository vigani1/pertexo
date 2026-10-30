import type { ReactNode } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import { Link, useMatches } from '@tanstack/react-router';
import {
  shortRunId,
  workflowLabel,
} from '@/features/workflow-runs/labels.public';
import type { ApiClient } from '@/lib/api/client';
import { RequestName, TableName } from './crumb-names';

/** What the run page's loader knows about its run, for the breadcrumb. */
export type RunCrumb = Readonly<{
  id: string;
  workflowId: string;
  workflowName: string | null;
}>;

/** One step of the workspace breadcrumb after the switcher. */
export type Crumb = Readonly<{ key: string; label: ReactNode }>;

export type NameScope = Readonly<{ apiClient: ApiClient; userId: string }>;

type CrumbSource =
  | Readonly<{ kind: 'page'; label: string }>
  | Readonly<{ kind: 'run'; run: RunCrumb | undefined }>
  | Readonly<{ kind: 'settings' }>
  | Readonly<{ kind: 'usage' }>
  | Readonly<{ kind: 'request'; taskId: string }>
  | Readonly<{ kind: 'table'; tableId: string }>;

// Pages that sit under another page get that page as a step to go back up.
const SHELL = '/w/$workspaceId/shell';
const SETTINGS_HUB = `${SHELL}/settings-hub`;

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

function linkCrumb(
  key: string,
  label: string,
  to:
    | '/w/$workspaceId/settings'
    | '/w/$workspaceId/settings/usage'
    | '/w/$workspaceId/requests'
    | '/w/$workspaceId/data-tables',
  workspaceId: string,
): Crumb {
  return {
    key,
    label: (
      <Link to={to} params={{ workspaceId }} className={crumbLinkClass}>
        {label}
      </Link>
    ),
  };
}

/**
 * The breadcrumb for the page on screen, every step but the last leading
 * back up: "Settings / Alerts", "Settings / Usage / Trends", "Requests /
 * Refund over limit", "Data tables / Shipments", and for a run the trail
 * back through Runs and its workflow. A record is named, never "Request".
 */
export function useShellCrumbs(
  workspace: AccessibleWorkspace,
  scope: NameScope,
): readonly Crumb[] {
  const sources = useMatches({
    select: (matches) =>
      matches.flatMap((match): CrumbSource[] => {
        // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- Special crumbs need route-specific data; remaining routes use declarative metadata.
        switch (match.routeId) {
          case `${SHELL}/runs/$runId`:
            return [
              {
                kind: 'run',
                run: match.loaderData?.found ? match.loaderData.run : undefined,
              },
            ];
          case SETTINGS_HUB:
            return [{ kind: 'settings' }];
          case `${SETTINGS_HUB}/settings/usage/trends`:
            return [{ kind: 'usage' }, { kind: 'page', label: 'Trends' }];
          case `${SHELL}/requests/$taskId`:
          case `${SHELL}/approvals/$taskId`:
            return [{ kind: 'request', taskId: match.params.taskId }];
          case `${SHELL}/data-tables/$tableId`:
            return [{ kind: 'table', tableId: match.params.tableId }];
        }
        const label = match.staticData.crumb;
        return label === undefined || label === 'Home'
          ? []
          : [{ kind: 'page', label }];
      }),
    structuralSharing: true,
  });
  // General is Settings itself: one plain step, not a link to the same page.
  const last = sources.at(-1);
  const trail =
    last?.kind === 'page' && last.label === 'Settings'
      ? sources.filter((source) => source.kind !== 'settings')
      : sources;
  return trail.flatMap((source): readonly Crumb[] => {
    switch (source.kind) {
      case 'page':
        return [{ key: source.label, label: source.label }];
      case 'run':
        return runCrumbs(workspace, source.run);
      case 'settings':
        return [
          linkCrumb(
            'settings',
            'Settings',
            '/w/$workspaceId/settings',
            workspace.id,
          ),
        ];
      case 'usage':
        return [
          linkCrumb(
            'usage',
            'Usage',
            '/w/$workspaceId/settings/usage',
            workspace.id,
          ),
        ];
      case 'request':
        return [
          linkCrumb(
            'requests',
            'Requests',
            '/w/$workspaceId/requests',
            workspace.id,
          ),
          {
            key: 'request',
            label: (
              <RequestName
                scope={scope}
                workspaceId={workspace.id}
                taskId={source.taskId}
              />
            ),
          },
        ];
      case 'table':
        return [
          linkCrumb(
            'data-tables',
            'Data tables',
            '/w/$workspaceId/data-tables',
            workspace.id,
          ),
          {
            key: 'table',
            label: (
              <TableName
                scope={scope}
                workspaceId={workspace.id}
                tableId={source.tableId}
              />
            ),
          },
        ];
    }
  });
}
