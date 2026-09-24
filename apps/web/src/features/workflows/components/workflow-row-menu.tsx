import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type { WorkflowSummary } from '@pertexo/contracts/schemas/workflow-authoring';
import { Link } from '@tanstack/react-router';
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CopyIcon,
  HistoryIcon,
  EllipsisIcon,
  PencilRulerIcon,
  CirclePlayIcon,
  SettingsIcon,
  ZapIcon,
} from 'lucide-react';
import { buttonVariants } from '@/components/ui/button-variants';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useNotifications } from '@/components/ui/use-notifications';
import { cn } from '@/lib/utils';

/**
 * The row's ⋯ menu: the hub tabs, copying the ID (never shown in the row)
 * and archive/restore for people who can publish.
 */
export function WorkflowRowMenu({
  workspace,
  workflow,
  onLifecycle,
}: Readonly<{
  workspace: AccessibleWorkspace;
  workflow: WorkflowSummary;
  onLifecycle: (workflow: WorkflowSummary) => void;
}>) {
  const notifications = useNotifications();
  const params = { workspaceId: workspace.id, workflowId: workflow.id };
  const can = (capability: AccessibleWorkspace['capabilities'][number]) =>
    workspace.capabilities.includes(capability);
  const archived = workflow.lifecycleStatus === 'archived';

  async function copyId() {
    try {
      await navigator.clipboard.writeText(workflow.id);
      notifications.success({
        title: 'Workflow ID copied',
        description: workflow.name,
      });
    } catch {
      notifications.error({
        title: 'Couldn’t copy the ID',
        description:
          'Your browser blocked clipboard access. Open Settings to copy it there.',
      });
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Actions for ${workflow.name}`}
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
          'pointer-fine:opacity-0 pointer-fine:group-focus-within/row:opacity-100 pointer-fine:group-hover/row:opacity-100 aria-expanded:opacity-100',
        )}
      >
        <EllipsisIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-52">
        <DropdownMenuLinkItem
          render={
            <Link to="/w/$workspaceId/workflows/$workflowId" params={params} />
          }
        >
          <PencilRulerIcon aria-hidden="true" />
          Open in Build
        </DropdownMenuLinkItem>
        {can('run:read') ? (
          <DropdownMenuLinkItem
            render={
              <Link
                to="/w/$workspaceId/workflows/$workflowId/runs"
                params={params}
              />
            }
          >
            <CirclePlayIcon aria-hidden="true" />
            Runs
          </DropdownMenuLinkItem>
        ) : null}
        <DropdownMenuLinkItem
          render={
            <Link
              to="/w/$workspaceId/workflows/$workflowId/triggers"
              params={params}
            />
          }
        >
          <ZapIcon aria-hidden="true" />
          Triggers
        </DropdownMenuLinkItem>
        <DropdownMenuLinkItem
          render={
            <Link
              to="/w/$workspaceId/workflows/$workflowId/versions"
              params={params}
            />
          }
        >
          <HistoryIcon aria-hidden="true" />
          Versions
        </DropdownMenuLinkItem>
        <DropdownMenuLinkItem
          render={
            <Link
              to="/w/$workspaceId/workflows/$workflowId/settings"
              params={params}
            />
          }
        >
          <SettingsIcon aria-hidden="true" />
          Settings
        </DropdownMenuLinkItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void copyId()}>
          <CopyIcon aria-hidden="true" />
          Copy ID
        </DropdownMenuItem>
        {can('workflow:publish') ? (
          <DropdownMenuItem
            variant={archived ? 'default' : 'destructive'}
            onClick={() => {
              onLifecycle(workflow);
            }}
          >
            {archived ? (
              <ArchiveRestoreIcon aria-hidden="true" />
            ) : (
              <ArchiveIcon aria-hidden="true" />
            )}
            {archived ? 'Restore…' : 'Archive…'}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
