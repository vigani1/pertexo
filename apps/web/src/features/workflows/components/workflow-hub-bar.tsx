import { WorkflowHubTabs, type WorkflowHubTab } from './workflow-hub-tabs';
import { useRef, useState, type ReactNode, type RefObject } from 'react';
import type { AccessibleWorkspace, WorkflowSummary } from '@pertexo/contracts';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeftIcon, EllipsisIcon, MessageSquareIcon } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button-variants';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { Skeleton } from '@/components/ui/skeleton';
import type { ApiClient } from '@/lib/api/client';
import { cn } from '@/lib/class-names';
import { WorkflowActivationState } from './activation-state';
import { WorkflowNameWithDialog } from './workflow-name-field';
import { WorkflowDuplicateAction } from './duplicate/workflow-duplicate-action';
import { WorkflowExportAction } from './portability/export-action';
import { WorkflowTemplateOrigin } from './templates/origin';
import { InputCasesAction } from './input-cases/action';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { canDuplicateWorkflow } from '../model/duplicate/allowed';

/** Below Tailwind's sm breakpoint, where the page's own controls fold away. */
const PHONE_MEDIA_QUERY = '(max-width: 39.999rem)';

const TITLE_CLASS =
  'truncate font-display text-lg leading-tight [--display-optical-size:19] [--display-width:84%]';

/**
 * The floating command bar shared by every tab of a workflow: identity on
 * the left (editors rename it in place) with its discussion, the five tabs
 * (Build, Runs, Triggers, Versions, Settings) in the middle, the active
 * tab's own actions on the right. `glyph` sits before the name (the
 * editor's pattern glyph) and `detail` under it (e.g. its save state).
 */
export function WorkflowHubBar({
  workflow,
  activeTab,
  duplicateBlocked = false,
  overflowRef,
  scope,
  slots = {},
}: Readonly<{
  workflow: WorkflowSummary | undefined;
  activeTab: WorkflowHubTab;
  duplicateBlocked?: boolean;
  overflowRef?: RefObject<HTMLButtonElement | null>;
  scope: Readonly<{
    apiClient: ApiClient;
    userId: string;
    workspace: AccessibleWorkspace;
    workflowId: string;
  }>;
  slots?: Readonly<{
    glyph?: ReactNode;
    presence?: ReactNode;
    detail?: ReactNode;
    actions?: ReactNode;
    overflowActions?: ReactNode;
    phoneOverflowActions?: ReactNode;
  }>;
}>) {
  const { apiClient, userId, workspace, workflowId } = scope;

  const { glyph, presence, detail, actions, overflowActions } = slots;
  const build = activeTab === 'build';

  const secondaryActions =
    workflow === undefined ? null : (
      <HubSecondaryActions
        key={`${userId}:${workspace.id}:${workflowId}`}
        apiClient={apiClient}
        userId={userId}
        workspace={workspace}
        workflow={workflow}
        blocked={duplicateBlocked}
        compact={activeTab === 'build'}
        overflowActions={overflowActions}
        phoneOverflowActions={slots.phoneOverflowActions}
        overflowRef={overflowRef}
      />
    );
  return (
    // Keep room for the identity before fitting tabs and actions beside it.
    // Intermediate widths put the tabs on their own row instead of squeezing saves.
    <header
      className={cn(
        'lens relative z-30 flex min-h-14 flex-wrap items-center gap-x-4 gap-y-0 rounded-xl px-2 py-1 sm:gap-y-1 sm:py-2',
        activeTab === 'build'
          ? 'max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:gap-x-1 max-sm:py-0.5 xl:grid xl:grid-cols-[minmax(0,1fr)_auto_auto]'
          : 'min-[1728px]:grid min-[1728px]:grid-cols-[minmax(20rem,1fr)_auto_auto]',
      )}
    >
      <div
        className={cn(
          'flex min-w-[min(100%,20rem)] flex-1 items-center gap-3 min-[1728px]:min-w-0',
          build &&
            'max-sm:min-w-0 max-sm:gap-1 max-[380px]:col-span-2 xl:min-w-0',
        )}
      >
        <Link
          to="/w/$workspaceId/workflows"
          params={{ workspaceId: workspace.id }}
          aria-label="Back to workflows"
          className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
        >
          <ArrowLeftIcon aria-hidden="true" />
        </Link>
        {glyph}
        <div className="min-w-0 flex-1">
          {workflow === undefined ? (
            // The name is still loading: hold its place instead of showing
            // a stand-in word that then changes.
            <>
              <h1 className="sr-only">Workflow</h1>
              <Skeleton className="my-1 h-3.5 w-40" />
            </>
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
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 max-sm:relative max-sm:z-10 max-sm:flex-nowrap max-sm:gap-x-1 gap-y-0.5 font-mono text-caption text-subtle-foreground">
            <WorkflowActivationState
              workspace={workspace}
              workflowId={workflowId}
              workflow={workflow}
              activeTab={activeTab}
            />
            {detail}
            {/* Appended to a line that already exists, so it moves nothing
                when it arrives; a phone reads it in Settings instead. */}
            <WorkflowTemplateOrigin
              apiClient={apiClient}
              userId={userId}
              workspace={workspace}
              workflowId={workflowId}
              className="min-w-0 truncate max-sm:hidden"
            />
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <div
            className={
              build
                ? 'max-sm:absolute max-sm:right-2 max-sm:bottom-0.5'
                : undefined
            }
          >
            {presence}
          </div>
          {/* The discussion sits beside who's here, not among the five
              tabs that build and run the workflow. */}
          <Link
            to="/w/$workspaceId/workflows/$workflowId/comments"
            params={{ workspaceId: workspace.id, workflowId }}
            aria-label="Comments"
            aria-current={activeTab === 'comments' ? 'page' : undefined}
            className={cn(
              buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
              // A phone keeps its row for the name and save state; Comments
              // waits in ⋯ there.
              activeTab === 'build' ? 'hidden' : 'max-sm:hidden',
            )}
          >
            <MessageSquareIcon aria-hidden="true" />
          </Link>
          {actions === undefined ? secondaryActions : null}
        </div>
      </div>
      <WorkflowHubTabs
        activeTab={activeTab}
        workspace={workspace}
        workflowId={workflowId}
        className={cn(
          build &&
            'max-sm:col-span-2 max-sm:row-start-2 max-[380px]:row-start-3',
          build && presence !== undefined && 'max-sm:w-[calc(100%-2.75rem)]',
        )}
      />
      <div
        className={cn(
          'flex max-w-full flex-wrap items-center gap-1.5 max-sm:w-full max-sm:flex-nowrap min-[1728px]:justify-self-end',
          build &&
            'max-sm:col-start-2 max-sm:row-start-1 max-sm:w-auto max-sm:gap-0.5 max-[380px]:col-span-2 max-[380px]:col-start-1 max-[380px]:row-start-2 max-[380px]:justify-self-end',
          actions === undefined && 'hidden',
        )}
      >
        {actions === undefined ? null : secondaryActions}
        {actions}
      </div>
    </header>
  );
}

/** Dialog owners persist outside the popup, including through uncertain commands. */
function HubSecondaryActions({
  apiClient,
  userId,
  workspace,
  workflow,
  blocked,
  compact,
  overflowActions,
  phoneOverflowActions,
  overflowRef,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflow: WorkflowSummary;
  blocked: boolean;
  compact: boolean;
  overflowActions: ReactNode;
  phoneOverflowActions: ReactNode;
  overflowRef: RefObject<HTMLButtonElement | null> | undefined;
}>) {
  const [dialog, setDialog] = useState<'export' | 'cases' | 'duplicate'>();
  const phone = useMediaQuery(PHONE_MEDIA_QUERY);
  const navigate = useNavigate();
  const localRef = useRef<HTMLButtonElement>(null);
  const moreRef = overflowRef ?? localRef;
  function finalFocus() {
    const trigger = moreRef.current;
    return trigger !== null && trigger.getClientRects().length > 0
      ? trigger
      : true;
  }
  const read = workspace.capabilities.includes('workflow:read');
  const scope = { apiClient, userId, workspace };
  const dialogProps = {
    workflow,
    finalFocus,
    // Below 2xl these three fold into the ⋯ menu, so a laptop-width header
    // keeps its actions on the name's row instead of a row of their own.
    triggerClassName: compact ? 'hidden' : 'hidden 2xl:inline-flex',
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          ref={moreRef}
          aria-label="More workflow actions"
          className={cn(
            buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
            'shrink-0',
            !compact && '2xl:hidden',
          )}
        >
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            {read ? (
              <>
                <DropdownMenuItem
                  disabled={blocked}
                  onClick={() => {
                    setDialog('export');
                  }}
                >
                  Export…
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setDialog('cases');
                  }}
                >
                  Input cases
                </DropdownMenuItem>
              </>
            ) : null}
            {phone || compact ? (
              <DropdownMenuItem
                onClick={() =>
                  void navigate({
                    to: '/w/$workspaceId/workflows/$workflowId/comments',
                    params: {
                      workspaceId: workspace.id,
                      workflowId: workflow.id,
                    },
                  })
                }
              >
                Comments
              </DropdownMenuItem>
            ) : null}
            {canDuplicateWorkflow(workspace, workflow) ? (
              <DropdownMenuItem
                disabled={blocked}
                onClick={() => {
                  setDialog('duplicate');
                }}
              >
                Duplicate…
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuGroup>
          {/* The page's own controls join the menu only on phones; hidden
              items would still take arrow-key turns, so they aren't rendered. */}
          {overflowActions === undefined &&
          (!phone || phoneOverflowActions === undefined) ? null : (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                {phone ? phoneOverflowActions : null}
                {overflowActions}
              </DropdownMenuGroup>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <WorkflowExportAction
        scope={scope}
        {...dialogProps}
        blocked={blocked}
        open={dialog === 'export'}
        onOpenChange={(open) => {
          setDialog(open ? 'export' : undefined);
        }}
      />
      <InputCasesAction
        {...scope}
        {...dialogProps}
        open={dialog === 'cases'}
        onOpenChange={(open) => {
          setDialog(open ? 'cases' : undefined);
        }}
      />
      <WorkflowDuplicateAction
        scope={scope}
        {...dialogProps}
        blocked={blocked}
        open={dialog === 'duplicate'}
        onOpenChange={(open) => {
          setDialog(open ? 'duplicate' : undefined);
        }}
      />
    </>
  );
}
