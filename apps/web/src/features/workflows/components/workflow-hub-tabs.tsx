import type { AccessibleWorkspace } from '@pertexo/contracts';
import { Link, type LinkProps } from '@tanstack/react-router';
import { cn } from '@/lib/class-names';
import { tabTileClass } from '@/components/ui/tabs';

export type WorkflowHubTab =
  'build' | 'runs' | 'triggers' | 'versions' | 'comments' | 'settings';

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
    | '/w/$workspaceId/workflows/$workflowId/comments'
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

export function WorkflowHubTabs({
  activeTab,
  workspace,
  workflowId,
  className,
}: Readonly<{
  activeTab: WorkflowHubTab;
  workspace: AccessibleWorkspace;
  workflowId: string;
  className?: string | undefined;
}>) {
  return (
    <nav
      aria-label="Workflow sections"
      className={cn(
        'order-last flex w-full items-center gap-1 overflow-x-auto p-0.5 min-[1728px]:order-none min-[1728px]:w-auto',
        activeTab === 'build' && 'xl:order-none xl:w-auto',
        className,
      )}
    >
      {hubTabs(workspace).map((link) => (
        <Link
          key={link.tab}
          to={link.to}
          params={{ workspaceId: workspace.id, workflowId }}
          activeOptions={{ exact: true }}
          aria-current={link.tab === activeTab ? 'page' : undefined}
          className={cn(tabTileClass, 'px-2 sm:px-3')}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
