import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type { WorkflowSummary } from '@pertexo/contracts/schemas/workflow-authoring';
import { Link } from '@tanstack/react-router';
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CopyIcon,
  HistoryIcon,
  EllipsisIcon,
  PencilIcon,
  PencilRulerIcon,
  CirclePlayIcon,
  PlayIcon,
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
import { Kbd } from '@/components/ui/kbd';
import { useCopyToClipboard } from '@/components/ui/use-copy-to-clipboard';
import { cn } from '@/lib/utils';
import { canRenameWorkflow } from '../model/workflow-rename';
import {
  ROW_REVEAL_CLASS,
  type WorkflowRowActions,
} from './workflow-row-actions';

/**
 * The row's ⋯ menu: Run for people who can start it, the hub tabs, renaming
 * for editors, copying the ID (never shown in the row) and archive/restore
 * for people who can publish.
 */
export function WorkflowRowMenu({
  workspace,
  workflow,
  actions,
  runnable,
}: Readonly<{
  workspace: AccessibleWorkspace;
  workflow: WorkflowSummary;
  actions: WorkflowRowActions;
  /** The published version can be started from here right now. */
  runnable: boolean;
}>) {
  const params = { workspaceId: workspace.id, workflowId: workflow.id };
  const can = (capability: AccessibleWorkspace['capabilities'][number]) =>
    workspace.capabilities.includes(capability);
  const archived = workflow.lifecycleStatus === 'archived';

  const copy = useCopyToClipboard();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Actions for ${workflow.name}`}
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
          ROW_REVEAL_CLASS,
        )}
      >
        <EllipsisIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-52">
        {runnable ? (
          <>
            <DropdownMenuItem
              onClick={() => {
                actions.onRun(workflow);
              }}
            >
              <PlayIcon aria-hidden="true" />
              Run
              <Kbd aria-hidden="true" className="ml-auto">
                R
              </Kbd>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : null}
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
        {canRenameWorkflow(workspace, workflow) ? (
          <DropdownMenuItem
            onClick={() => {
              actions.onRename(workflow);
            }}
          >
            <PencilIcon aria-hidden="true" />
            Rename…
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          onClick={() =>
            void copy(workflow.id, 'workflow ID', {
              description: workflow.name,
              elsewhere: 'Open Settings to copy it there.',
            })
          }
        >
          <CopyIcon aria-hidden="true" />
          Copy ID
        </DropdownMenuItem>
        {can('workflow:publish') ? (
          <DropdownMenuItem
            variant={archived ? 'default' : 'destructive'}
            onClick={() => {
              actions.onLifecycle(workflow);
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
