import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { AccessibleWorkspace } from '@pertexo/contracts';
import { workflowRunIdentifierSchema } from '@pertexo/contracts';
import {
  LayoutGridIcon,
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
} from '@/features/workflows/queries.public';
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

  const shown =
    typed === ''
      ? (workflows.data?.pages ?? []).flatMap((page) => page.items)
      : (found.data?.pages ?? []).flatMap((page) =>
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

  const accountItems: CommandItem[] = [
    {
      id: 'switch-theme',
      label: 'Switch theme',
      keywords: 'appearance system light dark',
      icon: <SunMoonIcon />,
      onSelect: () => {
        setThemeOpen(true);
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

  const groups: CommandGroup[] = [
    { label: 'Go to', items: places },
    ...(workflowItems.length === 0
      ? []
      : [{ label: 'Workflows', items: workflowItems }]),
    { label: 'Account', items: accountItems },
  ];

  return (
    <>
      <CommandPalette
        open={open}
        onOpenChange={onOpenChange}
        groups={groups}
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

function workspacePlaces({
  workspace,
  navigate,
}: Readonly<{
  workspace: AccessibleWorkspace;
  navigate: ReturnType<typeof useNavigate>;
}>): CommandItem[] {
  const params = { workspaceId: workspace.id };
  const items: readonly (CommandItem & Parameters<typeof canOpenPlace>[1])[] = [
    {
      ...WORKSPACE_PLACES.usage,
      id: 'usage',
      keywords: 'capacity retained activity limits',
      onSelect: () =>
        void navigate({
          to: WORKSPACE_PLACES.usage.to,
          params,
          search: { window: '24h' },
        }),
    },
    {
      ...WORKSPACE_PLACES.home,
      id: 'home',
      onSelect: () => void navigate({ to: WORKSPACE_PLACES.home.to, params }),
    },
    {
      ...WORKSPACE_PLACES.workflows,
      id: 'workflows',
      onSelect: () =>
        void navigate({ to: WORKSPACE_PLACES.workflows.to, params }),
    },
    {
      ...WORKSPACE_PLACES.runs,
      id: 'runs',
      onSelect: () => void navigate({ to: WORKSPACE_PLACES.runs.to, params }),
    },
    {
      ...WORKSPACE_PLACES.connections,
      id: 'connections',
      onSelect: () =>
        void navigate({ to: WORKSPACE_PLACES.connections.to, params }),
    },
    {
      ...WORKSPACE_PLACES.team,
      id: 'team',
      keywords: 'members invitations roles',
      onSelect: () => void navigate({ to: WORKSPACE_PLACES.team.to, params }),
    },
    {
      ...WORKSPACE_PLACES.alerts,
      id: 'alerts',
      keywords: 'failure notifications destinations',
      onSelect: () => void navigate({ to: WORKSPACE_PLACES.alerts.to, params }),
    },
    {
      ...WORKSPACE_PLACES.settings,
      id: 'settings',
      label: 'Workspace settings',
      onSelect: () =>
        void navigate({ to: WORKSPACE_PLACES.settings.to, params }),
    },
    {
      ...WORKSPACE_PLACES.apiTokens,
      id: 'api-tokens',
      keywords: 'scripts automation personal access',
      onSelect: () =>
        void navigate({ to: WORKSPACE_PLACES.apiTokens.to, params }),
    },
  ];
  return items.filter((item) => canOpenPlace(workspace, item));
}
