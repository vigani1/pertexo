import type { ReadQuery } from '@/components/patterns/states/query-view';
import { ReadRecovery } from '@/components/patterns/states/read-recovery';
import { shownData } from '@/lib/api/error-copy';
import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import { workflowRunIdentifierSchema } from '@pertexo/contracts';
import { HELP_LINKS } from '@/lib/help/guides';
import {
  BookOpenIcon,
  LayoutGridIcon,
  PlugIcon,
  PlusIcon,
  UserPlusIcon,
  LogOutIcon,
  SunMoonIcon,
  ShieldCheckIcon,
  WavesIcon,
  WorkflowIcon,
} from 'lucide-react';
import {
  CommandPalette,
  type CommandGroup,
  type CommandItem,
} from '@/components/patterns/command-palette';
import {
  workflowNameSearchQueryOptions,
  workflowsInfiniteQueryOptions,
} from '@/features/workflows/workflows-queries.public';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { AppearanceChoice } from '@/components/patterns/appearance/choice';
import {
  WORKSPACE_PLACES,
  canOpenPlace,
} from '@/features/workspaces/places.public';
import { useWorkspaceScope } from './use-workspace-scope';

export function WorkspaceCommandPalette({
  open,
  onOpenChange,
  workspaces,
  onLogout,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaces: readonly AccessibleWorkspace[];
  onLogout: () => void;
}>) {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const navigate = useNavigate();
  const workspaceId = workspace.id;
  const can = (capability: (typeof workspace.capabilities)[number]) =>
    workspace.capabilities.includes(capability);
  const [typed, setTyped] = useState('');
  const [themeOpen, setThemeOpen] = useState(false);
  const workflows = useInfiniteQuery({
    ...workflowsInfiniteQueryOptions(apiClient, user.id, workspaceId),
    enabled: open && can('workflow:read'),
  });
  // Recent workflows fill an empty search; typed text searches all of them
  // on the server, so a large workspace finds any workflow by name.
  const found = useInfiniteQuery({
    ...workflowNameSearchQueryOptions(apiClient, user.id, workspaceId, typed),
    enabled: open && can('workflow:read') && typed !== '',
  });

  const places = workspacePlaces({ workspace, navigate });

  const searchQuery = typed === '' ? workflows : found;
  const shown = (shownData(searchQuery)?.pages ?? []).flatMap((page) =>
    page.items.map((item) => ('workflow' in item ? item.workflow : item)),
  );
  const workflowItems: CommandItem[] = shown.map((workflow) => ({
    id: `workflow-${workflow.id}`,
    label: workflow.name,
    icon: <WorkflowIcon />,
    ...(workflow.lifecycleStatus === 'archived' ? { hint: 'Archived' } : {}),
    onSelect: () =>
      void navigate({
        to: '/w/$workspaceId/workflows/$workflowId',
        params: { workspaceId, workflowId: workflow.id },
      }),
  }));

  if (typed !== '' && found.hasNextPage)
    workflowItems.push({
      id: 'all-search-results',
      label: `See all results for “${typed}”`,
      keywords: typed,
      onSelect: () => {
        void navigate({
          to: '/w/$workspaceId/workflows',
          params: { workspaceId },
          search: { query: typed, view: 'all' },
        });
      },
    });
  const searchState = paletteSearchState(searchQuery);
  const accountItems = workspaceAccountItems({
    workspaces,
    workspaceId,
    navigate,
    onLogout,
    onTheme: () => {
      setThemeOpen(true);
    },
  });

  const actions = workspaceActions({ workspace, navigate });
  const groups: CommandGroup[] = [
    ...(actions.length === 0 ? [] : [{ label: 'Actions', items: actions }]),
    { label: 'Go to', items: places },
    ...(workflowItems.length === 0
      ? []
      : [{ label: 'Workflows', items: workflowItems }]),
    { label: 'Help', items: HELP_ITEMS },
    { label: 'Account', items: accountItems },
  ];

  return (
    <>
      <CommandPalette
        open={open}
        onOpenChange={onOpenChange}
        groups={groups}
        search={can('workflow:read') ? searchState : undefined}
        onQueryChange={setTyped}
        resolveQuery={(query) => {
          if (!can('run:read')) return undefined;
          const runId = workflowRunIdentifierSchema.safeParse(query);
          if (!runId.success) return undefined;
          return {
            label: 'Run',
            items: [
              {
                id: `run-${runId.data}`,
                label: `Open run ${runId.data.slice(0, 8)}…`,
                keywords: runId.data,
                icon: <WavesIcon />,
                onSelect: () =>
                  void navigate({
                    to: '/w/$workspaceId/runs/$runId',
                    params: { workspaceId, runId: runId.data },
                  }),
              },
            ],
          };
        }}
      />
      <Dialog open={themeOpen} onOpenChange={setThemeOpen}>
        <DialogContent>
          <DialogTitle>Switch theme</DialogTitle>
          <DialogDescription>
            Saved for this browser, across workspaces. System follows your
            device’s appearance.
          </DialogDescription>
          <AppearanceChoice />
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Every page this role can open, in the spine's order: the everyday places
 * first, then settings. Keywords catch the words people search with.
 */
function workspacePlaces({
  workspace,
  navigate,
}: Readonly<{
  workspace: AccessibleWorkspace;
  navigate: ReturnType<typeof useNavigate>;
}>): CommandItem[] {
  const params = { workspaceId: workspace.id };
  const place = (
    key: keyof typeof WORKSPACE_PLACES,
    extra: Partial<CommandItem> = {},
  ) => ({
    ...WORKSPACE_PLACES[key],
    id: key,
    onSelect: () => void navigate({ to: WORKSPACE_PLACES[key].to, params }),
    ...extra,
  });
  const items: readonly (CommandItem & Parameters<typeof canOpenPlace>[1])[] = [
    place('home'),
    place('workflows'),
    place('runs', { keywords: 'history timeline executions' }),
    place('inbox', { keywords: 'notices failures notifications' }),
    place('approvals', { keywords: 'tasks decisions waiting' }),
    place('dataTables', { keywords: 'rows records tables' }),
    place('connections', { keywords: 'credentials slack http email' }),
    place('team', { keywords: 'members invitations roles' }),
    place('alerts', { keywords: 'failure notifications destinations' }),
    place('variables', { keywords: 'configuration values secrets' }),
    place('usage', {
      keywords: 'capacity retained activity limits',
      onSelect: () =>
        void navigate({
          to: WORKSPACE_PLACES.usage.to,
          params,
          search: { window: '24h' },
        }),
    }),
    place('settings', { label: 'Workspace settings' }),
    place('audit', { keywords: 'history changes who did what' }),
    place('apiTokens', { keywords: 'scripts automation personal access' }),
  ];
  return items.filter((item) => canOpenPlace(workspace, item));
}

/** Things to do, not places: the actions people most often come for. */
function workspaceActions({
  workspace,
  navigate,
}: Readonly<{
  workspace: AccessibleWorkspace;
  navigate: ReturnType<typeof useNavigate>;
}>): CommandItem[] {
  const params = { workspaceId: workspace.id };
  const can = (capability: (typeof workspace.capabilities)[number]) =>
    workspace.capabilities.includes(capability);
  return [
    ...(can('workflow:create')
      ? [
          {
            id: 'new-workflow',
            label: 'New workflow',
            keywords: 'create blank example template',
            icon: <PlusIcon />,
            onSelect: () =>
              void navigate({
                to: '/w/$workspaceId/workflows',
                params,
                search: { create: true },
              }),
          },
        ]
      : []),
    ...(can('connection:manage')
      ? [
          {
            id: 'add-connection',
            label: 'Add a connection',
            keywords: 'connect slack http email credential',
            icon: <PlugIcon />,
            onSelect: () =>
              void navigate({
                to: '/w/$workspaceId/connections',
                params,
                search: { add: 'any' },
              }),
          },
        ]
      : []),
    ...(can('member:manage')
      ? [
          {
            id: 'invite-people',
            label: 'Invite people',
            keywords: 'teammate member invitation',
            icon: <UserPlusIcon />,
            onSelect: () =>
              void navigate({
                to: '/w/$workspaceId/team',
                params,
                search: { invite: true },
              }),
          },
        ]
      : []),
  ];
}

/** The public guides, each opening in a new tab. */
const HELP_ITEMS: readonly CommandItem[] = [
  {
    id: 'help-first-workflow',
    label: 'Guide: your first workflow',
    keywords: 'help docs getting started tutorial',
    icon: <BookOpenIcon />,
    onSelect: () => {
      window.open(HELP_LINKS.firstWorkflow, '_blank', 'noopener');
    },
  },
  {
    id: 'help-guides',
    label: 'All guides',
    keywords: 'help docs documentation',
    icon: <BookOpenIcon />,
    onSelect: () => {
      window.open(HELP_LINKS.allGuides, '_blank', 'noopener');
    },
  },
  {
    id: 'help-glossary',
    label: 'Glossary',
    keywords: 'help terms words meaning',
    icon: <BookOpenIcon />,
    onSelect: () => {
      window.open(HELP_LINKS.glossary, '_blank', 'noopener');
    },
  },
];

function paletteSearchState(query: ReadQuery<unknown>) {
  if (query.isPending) return { status: 'loading' as const };
  if (!query.isError) return { status: 'ready' as const };
  return {
    status: 'failed' as const,
    feedback: (
      <>
        {query.data === undefined ? null : (
          <p>Showing earlier search results.</p>
        )}
        <ReadRecovery
          error={query.error}
          resource="Workflow search"
          retrying={query.isFetching}
          retry={() => {
            void query.refetch();
          }}
        />
      </>
    ),
  };
}
function workspaceAccountItems({
  workspaces,
  workspaceId,
  navigate,
  onLogout,
  onTheme,
}: Readonly<{
  workspaces: readonly AccessibleWorkspace[];
  workspaceId: string;
  navigate: ReturnType<typeof useNavigate>;
  onLogout: () => void;
  onTheme: () => void;
}>): CommandItem[] {
  return [
    {
      id: 'switch-theme',
      label: 'Switch theme',
      keywords: 'appearance system light dark',
      icon: <SunMoonIcon />,
      onSelect: () => {
        onTheme();
      },
    },
    ...workspaces
      .filter((candidate) => candidate.id !== workspaceId)
      .map((candidate) => ({
        id: `workspace-${candidate.id}`,
        label: `Switch to ${candidate.name}`,
        icon: <LayoutGridIcon />,
        onSelect: () =>
          void navigate({
            to: '/w/$workspaceId',
            params: { workspaceId: candidate.id },
          }),
      })),
    {
      id: 'account',
      label: 'Account & security',
      keywords: 'password sessions sign-in methods email',
      icon: <ShieldCheckIcon />,
      onSelect: () =>
        void navigate({
          to: '/w/$workspaceId/account',
          params: { workspaceId },
        }),
    },
    {
      id: 'sign-out',
      label: 'Sign out',
      icon: <LogOutIcon />,
      onSelect: onLogout,
    },
  ];
}
