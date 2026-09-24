import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { workflowRunIdentifierSchema } from '@pertexo/contracts/schemas/workflow-runs';
import {
  BellIcon,
  HomeIcon,
  LayoutGridIcon,
  LogOutIcon,
  PlugIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  UsersIcon,
  WavesIcon,
  WorkflowIcon,
} from 'lucide-react';
import {
  CommandPalette,
  type CommandGroup,
  type CommandItem,
} from '@/components/patterns/command-palette';
import { workflowsInfiniteQueryOptions } from '@/features/workflows/queries.public';
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
  const workflows = useInfiniteQuery({
    ...workflowsInfiniteQueryOptions(apiClient, user.id, workspaceId),
    enabled: open && can('workflow:read'),
  });

  const places: CommandItem[] = [
    {
      id: 'home',
      label: 'Home',
      icon: <HomeIcon />,
      onSelect: () =>
        void navigate({ to: '/w/$workspaceId', params: { workspaceId } }),
    },
    {
      id: 'workflows',
      label: 'Workflows',
      icon: <WorkflowIcon />,
      onSelect: () =>
        void navigate({
          to: '/w/$workspaceId/workflows',
          params: { workspaceId },
        }),
    },
    ...(can('run:read')
      ? [
          {
            id: 'runs',
            label: 'Runs',
            icon: <WavesIcon />,
            onSelect: () =>
              void navigate({
                to: '/w/$workspaceId/runs',
                params: { workspaceId },
              }),
          },
        ]
      : []),
    ...(can('connection:read')
      ? [
          {
            id: 'connections',
            label: 'Connections',
            icon: <PlugIcon />,
            onSelect: () =>
              void navigate({
                to: '/w/$workspaceId/connections',
                params: { workspaceId },
              }),
          },
        ]
      : []),
    ...(can('member:read')
      ? [
          {
            id: 'team',
            label: 'Team',
            keywords: 'members invitations roles',
            icon: <UsersIcon />,
            onSelect: () =>
              void navigate({
                to: '/w/$workspaceId/team',
                params: { workspaceId },
              }),
          },
        ]
      : []),
    ...(can('workflow:update')
      ? [
          {
            id: 'alerts',
            label: 'Alerts',
            keywords: 'failure notifications destinations',
            icon: <BellIcon />,
            onSelect: () =>
              void navigate({
                to: '/w/$workspaceId/alerts',
                params: { workspaceId },
              }),
          },
        ]
      : []),
    {
      id: 'settings',
      label: 'Workspace settings',
      icon: <SlidersHorizontalIcon />,
      onSelect: () =>
        void navigate({
          to: '/w/$workspaceId/settings',
          params: { workspaceId },
        }),
    },
  ];

  const workflowItems: CommandItem[] = (workflows.data?.pages ?? [])
    .flatMap((page) => page.items)
    .map((workflow) => ({
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
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      groups={groups}
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
  );
}
