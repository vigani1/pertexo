import { useRef, useState, type ReactNode, type RefObject } from 'react';
import type { AccessibleWorkspace, WorkflowSummary } from '@pertexo/contracts';
import { Link, type LinkProps } from '@tanstack/react-router';
import { ArrowLeftIcon, EllipsisIcon } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button-variants';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { Skeleton } from '@/components/ui/skeleton';
import type { ApiClient } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { WorkflowActivationState } from './header/activation-state';
import { WorkflowNameWithDialog } from './workflow-name-field';
import { WorkflowDuplicateAction } from './workflow-duplicate-action';
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
      tab: 'comments',
      label: 'Comments',
      to: '/w/$workspaceId/workflows/$workflowId/comments',
    },
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

/** Below Tailwind's sm breakpoint, where the page's own controls fold away. */
const PHONE_MEDIA_QUERY = '(max-width: 39.999rem)';

const TITLE_CLASS =
  'truncate font-display text-lg leading-tight [--display-optical-size:19] [--display-width:84%]';

/**
 * The floating command bar shared by every tab of a workflow: identity on
 * the left (editors rename it in place), tabs in the middle, the active
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
    mobileActions?: ReactNode;
  }>;
}>) {
  const { apiClient, userId, workspace, workflowId } = scope;

  const { glyph, presence, detail, actions, mobileActions } = slots;

  const secondaryActions =
    workflow === undefined ? null : (
      <HubSecondaryActions
        key={`${userId}:${workspace.id}:${workflowId}`}
        apiClient={apiClient}
        userId={userId}
        workspace={workspace}
        workflow={workflow}
        blocked={duplicateBlocked}
        mobileActions={mobileActions}
        overflowRef={overflowRef}
      />
    );
  return (
    // Keep room for the identity before fitting tabs and actions beside it.
    // Intermediate widths put the tabs on their own row instead of squeezing saves.
    <header className="lens relative z-30 flex min-h-14 flex-wrap items-center gap-x-4 gap-y-1 rounded-xl px-2 py-1.5 sm:gap-y-2 sm:py-2 min-[1728px]:grid min-[1728px]:grid-cols-[minmax(20rem,1fr)_auto_auto]">
      <div className="flex min-w-[min(100%,20rem)] flex-1 items-center gap-3 min-[1728px]:min-w-0">
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
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-[0.7rem] text-subtle-foreground">
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
          {presence}
          {actions === undefined ? secondaryActions : null}
        </div>
      </div>
      <nav
        aria-label="Workflow sections"
        className="order-last flex w-full items-center gap-1 overflow-x-auto rounded-md border border-surface-ink/6 bg-recess-ink/25 p-[3px] min-[1728px]:order-none min-[1728px]:w-auto"
      >
        {hubTabs(workspace).map((link) => (
          <Link
            key={link.tab}
            to={link.to}
            params={{ workspaceId: workspace.id, workflowId }}
            activeOptions={{ exact: true }}
            aria-current={link.tab === activeTab ? 'page' : undefined}
            className={cn(
              // Horizontal overflow keeps one fixed-height row, including Comments.
              'shrink-0 rounded-sm px-2 py-2 text-center text-[0.8rem] font-medium whitespace-nowrap text-subtle-foreground outline-none hover:text-foreground focus-ring sm:flex-none sm:px-3 sm:py-1.5',
              link.tab === activeTab &&
                'bg-action/10 text-accent-foreground shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--action)_22%,transparent)]',
            )}
          >
            {link.label}
          </Link>
        ))}
      </nav>
      <div
        className={cn(
          'flex max-w-full flex-wrap items-center gap-1.5 max-sm:w-full max-sm:flex-nowrap min-[1728px]:justify-self-end',
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
  mobileActions,
  overflowRef,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
  workflow: WorkflowSummary;
  blocked: boolean;
  mobileActions: ReactNode;
  overflowRef: RefObject<HTMLButtonElement | null> | undefined;
}>) {
  const [dialog, setDialog] = useState<'export' | 'cases' | 'duplicate'>();
  const phone = useMediaQuery(PHONE_MEDIA_QUERY);
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
    triggerClassName: 'hidden 2xl:inline-flex',
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          ref={moreRef}
          aria-label="More workflow actions"
          className={cn(
            buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
            'shrink-0 2xl:hidden',
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
          {mobileActions === undefined || !phone ? null : (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>{mobileActions}</DropdownMenuGroup>
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
