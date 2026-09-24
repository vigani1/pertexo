import type { ReactNode } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type { WorkflowSummary } from '@pertexo/contracts/schemas/workflow-authoring';
import { Link, type LinkProps } from '@tanstack/react-router';
import { ArrowLeftIcon } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button-variants';
import { Status } from '@/components/ui/status';
import { cn } from '@/lib/utils';
import { describeWorkflowState } from '../model/workflow-state';

export type WorkflowHubTab =
  'build' | 'runs' | 'triggers' | 'versions' | 'settings';

type TabLink = Readonly<{
  tab: WorkflowHubTab;
  label: string;
  to: Extract<
    LinkProps['to'],
    | '/w/$workspaceId/workflows/$workflowId'
    | '/w/$workspaceId/workflows/$workflowId/runs'
    | '/w/$workspaceId/workflows/$workflowId/triggers'
    | '/w/$workspaceId/workflows/$workflowId/versions'
    | '/w/$workspaceId/workflows/$workflowId/settings'
  >;
}>;

function hubTabs(workspace: AccessibleWorkspace): readonly TabLink[] {
  const tabs: TabLink[] = [
    {
      tab: 'build',
      label: 'Build',
      to: '/w/$workspaceId/workflows/$workflowId',
    },
  ];
  if (workspace.capabilities.includes('run:read'))
    tabs.push({
      tab: 'runs',
      label: 'Runs',
      to: '/w/$workspaceId/workflows/$workflowId/runs',
    });
  tabs.push(
    {
      tab: 'triggers',
      label: 'Triggers',
      to: '/w/$workspaceId/workflows/$workflowId/triggers',
    },
    {
      tab: 'versions',
      label: 'Versions',
      to: '/w/$workspaceId/workflows/$workflowId/versions',
    },
    {
      tab: 'settings',
      label: 'Settings',
      to: '/w/$workspaceId/workflows/$workflowId/settings',
    },
  );
  return tabs;
}

/**
 * The floating command bar shared by every tab of a workflow: identity on
 * the left, tabs in the middle, the active tab's own actions on the right.
 * `detail` sits under the name (e.g. the editor's save state).
 */
export function WorkflowHubBar({
  workspace,
  workflowId,
  workflow,
  activeTab,
  detail,
  actions,
}: Readonly<{
  workspace: AccessibleWorkspace;
  workflowId: string;
  workflow: WorkflowSummary | undefined;
  activeTab: WorkflowHubTab;
  detail?: ReactNode;
  actions?: ReactNode;
}>) {
  const state =
    workflow === undefined ? undefined : describeWorkflowState(workflow);
  return (
    <header className="lens relative z-30 flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 rounded-xl px-2 py-2 xl:flex-nowrap">
      <div className="flex min-w-0 flex-1 items-center gap-3 xl:flex-none">
        <Link
          to="/w/$workspaceId/workflows"
          params={{ workspaceId: workspace.id }}
          aria-label="Back to workflows"
          className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
        >
          <ArrowLeftIcon aria-hidden="true" />
        </Link>
        <div className="min-w-0">
          <h1 className="truncate font-heading text-lg leading-tight font-semibold tracking-[-0.02em]">
            {workflow?.name ?? 'Workflow'}
          </h1>
          <div className="flex min-w-0 items-center gap-2.5 font-mono text-[0.7rem] text-subtle-foreground">
            {state === undefined ? null : (
              <Status tone={state.tone} className="text-[0.7rem]">
                {state.label}
              </Status>
            )}
            {detail}
          </div>
        </div>
      </div>
      <nav
        aria-label="Workflow sections"
        className="order-last flex w-full items-center gap-1 overflow-x-auto rounded-md border border-white/6 bg-black/25 p-[3px] xl:order-none xl:mx-auto xl:w-auto"
      >
        {hubTabs(workspace).map((link) => (
          <Link
            key={link.tab}
            to={link.to}
            params={{ workspaceId: workspace.id, workflowId }}
            activeOptions={{ exact: true }}
            aria-current={link.tab === activeTab ? 'page' : undefined}
            className={cn(
              'rounded-sm px-3 py-1.5 text-[0.8rem] font-medium whitespace-nowrap text-subtle-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60',
              link.tab === activeTab &&
                'bg-primary/10 text-accent-foreground shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--primary)_22%,transparent)]',
            )}
          >
            {link.label}
          </Link>
        ))}
      </nav>
      {actions === undefined ? null : (
        <div className="flex items-center gap-1.5">{actions}</div>
      )}
    </header>
  );
}
