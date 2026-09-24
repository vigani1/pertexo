import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import type { WorkflowRunReadSummary } from '@pertexo/contracts/schemas/workflow-runs';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ArrowUpRightIcon,
  EllipsisIcon,
  OctagonXIcon,
  RotateCcwIcon,
  WorkflowIcon,
} from 'lucide-react';
import { useState } from 'react';
import { buttonVariants } from '@/components/ui/button-variants';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ApiClient } from '@/lib/api/client';
import { workflowLabel } from '../../model/run-list';
import { isActiveRunStatus } from '../../model/run-status';
import { CancelRunDialog } from './cancel-run-dialog';
import { ReplayRunDialog } from './replay-run-dialog';

/** Open, open workflow, replay and cancel for one run row. */
export function RunRowMenu({
  apiClient,
  userId,
  workspace,
  run,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  run: WorkflowRunReadSummary;
}>) {
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<'replay' | 'cancel'>();
  const can = (capability: AccessibleWorkspace['capabilities'][number]) =>
    workspace.capabilities.includes(capability);
  const canCancel =
    can('run:cancel') &&
    isActiveRunStatus(run.status) &&
    run.cancelRequestedAt === null;
  const name = workflowLabel(run);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Actions for ${name} run`}
          className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
        >
          <EllipsisIcon aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-52">
          <DropdownMenuLinkItem
            render={
              <Link
                to="/w/$workspaceId/runs/$runId"
                params={{ workspaceId: workspace.id, runId: run.id }}
              />
            }
          >
            <ArrowUpRightIcon aria-hidden="true" />
            Open run
          </DropdownMenuLinkItem>
          {can('workflow:read') ? (
            <DropdownMenuLinkItem
              render={
                <Link
                  to="/w/$workspaceId/workflows/$workflowId"
                  params={{
                    workspaceId: workspace.id,
                    workflowId: run.workflowId,
                  }}
                />
              }
            >
              <WorkflowIcon aria-hidden="true" />
              Open workflow
            </DropdownMenuLinkItem>
          ) : null}
          {can('run:replay') || canCancel ? <DropdownMenuSeparator /> : null}
          {can('run:replay') ? (
            <DropdownMenuItem
              onClick={() => {
                setDialog('replay');
              }}
            >
              <RotateCcwIcon aria-hidden="true" />
              Replay…
            </DropdownMenuItem>
          ) : null}
          {canCancel ? (
            <DropdownMenuItem
              variant="destructive"
              onClick={() => {
                setDialog('cancel');
              }}
            >
              <OctagonXIcon aria-hidden="true" />
              Cancel run…
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog === 'replay' ? (
        <ReplayRunDialog
          apiClient={apiClient}
          userId={userId}
          workspaceId={workspace.id}
          sourceRunId={run.id}
          workflowVersionId={run.workflowVersionId}
          open
          onOpenChange={(open) => {
            setDialog(open ? 'replay' : undefined);
          }}
          onRunAccepted={(runId) => {
            void navigate({
              to: '/w/$workspaceId/runs/$runId',
              params: { workspaceId: workspace.id, runId },
            });
          }}
        />
      ) : null}
      {dialog === 'cancel' ? (
        <CancelRunDialog
          apiClient={apiClient}
          userId={userId}
          workspaceId={workspace.id}
          runId={run.id}
          workflowName={name}
          open
          onOpenChange={(open) => {
            setDialog(open ? 'cancel' : undefined);
          }}
        />
      ) : null}
    </>
  );
}
