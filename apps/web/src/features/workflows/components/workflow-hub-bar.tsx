import type { ReactNode } from 'react';
import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type { WorkflowSummary } from '@pertexo/contracts/schemas/workflow-authoring';
import { Link, type LinkProps } from '@tanstack/react-router';
import { ArrowLeftIcon } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button-variants';
import { Status } from '@/components/ui/status';
import type { ApiClient } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { describeWorkflowState } from '../model/workflow-state';
import { WorkflowNameWithDialog } from './workflow-name-field';

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

const TITLE_CLASS =
  'truncate font-display text-lg leading-tight [--display-optical-size:19] [--display-width:84%]';

/**
 * The floating command bar shared by every tab of a workflow: identity on
 * the left (editors rename it in place), tabs in the middle, the active
 * tab's own actions on the right. `glyph` sits before the name (the
 * editor's pattern glyph) and `detail` under it (e.g. its save state).
 */
export function WorkflowHubBar({
  apiClient,
  userId,
  workspace,
  workflowId,
  workflow,
  activeTab,
  glyph,
  detail,
  actions,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflowId: string;
  workflow: WorkflowSummary | undefined;
  activeTab: WorkflowHubTab;
  glyph?: ReactNode;
  detail?: ReactNode;
  actions?: ReactNode;
}>) {
  const state =
    workflow === undefined ? undefined : describeWorkflowState(workflow);
  return (
    // On wide screens the tabs sit in a centre column of their own, so a
    // long name or a busy action group never pushes them sideways.
    <header className="lens relative z-30 flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 rounded-xl px-2 py-2 xl:grid xl:grid-cols-[minmax(0,1fr)_auto_minmax(max-content,1fr)]">
      <div className="flex min-w-[min(100%,12rem)] flex-1 items-center gap-3 xl:min-w-0">
        <Link
          to="/w/$workspaceId/workflows"
          params={{ workspaceId: workspace.id }}
          aria-label="Back to workflows"
          className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
        >
          <ArrowLeftIcon aria-hidden="true" />
        </Link>
        {glyph}
        <div className="min-w-0">
          {workflow === undefined ? (
            <h1 className={TITLE_CLASS}>Workflow</h1>
          ) : (
            <WorkflowNameWithDialog
              apiClient={apiClient}
              userId={userId}
              workspace={workspace}
              workflow={workflow}
            >
              <h1 className={TITLE_CLASS}>{workflow.name}</h1>
            </WorkflowNameWithDialog>
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-[0.7rem] text-subtle-foreground">
            {state === undefined ? null : (
              <Status tone={state.tone} className="font-sans text-[0.75rem]">
                {state.label}
              </Status>
            )}
            {detail}
            {/* Starting lasts until every trigger is ready; a webhook waits
                for its endpoint, so say where to look. */}
            {workflow?.activationStatus === 'activating' &&
            workflow.lifecycleStatus === 'active' &&
            activeTab !== 'triggers' ? (
              <Link
                to="/w/$workspaceId/workflows/$workflowId/triggers"
                params={{ workspaceId: workspace.id, workflowId }}
                className="inline-link font-sans text-[0.72rem] font-medium"
              >
                Check triggers
              </Link>
            ) : null}
          </div>
        </div>
      </div>
      <nav
        aria-label="Workflow sections"
        className="order-last flex w-full items-center gap-1 overflow-x-auto rounded-md border border-white/6 bg-black/25 p-[3px] xl:order-none xl:w-auto"
      >
        {hubTabs(workspace).map((link) => (
          <Link
            key={link.tab}
            to={link.to}
            params={{ workspaceId: workspace.id, workflowId }}
            activeOptions={{ exact: true }}
            aria-current={link.tab === activeTab ? 'page' : undefined}
            className={cn(
              // Equal segments on a phone, so every tab fits without scrolling.
              'flex-1 rounded-sm px-2 py-2 text-center text-[0.8rem] font-medium whitespace-nowrap text-subtle-foreground outline-none hover:text-foreground focus-ring sm:flex-none sm:px-3 sm:py-1.5',
              link.tab === activeTab &&
                'bg-action/10 text-accent-foreground shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--action)_22%,transparent)]',
            )}
          >
            {link.label}
          </Link>
        ))}
      </nav>
      {actions === undefined ? null : (
        <div className="flex items-center gap-1.5 xl:justify-self-end">
          {actions}
        </div>
      )}
    </header>
  );
}
