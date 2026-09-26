import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ArrowUpRightIcon,
  BellIcon,
  PlugIcon,
  UsersIcon,
  WorkflowIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { Status } from '@/components/ui/status';
import { PROVIDERS } from '@/features/connections/provider.public';
import { connectionsInfiniteQueryOptions } from '@/features/connections/queries.public';
import { failureNotificationDestinationsQueryOptions } from '@/features/failure-notifications/queries.public';
import { countWorkflowStates } from '@/features/workflows/counts.public';
import { workflowsInfiniteQueryOptions } from '@/features/workflows/queries.public';
import type { ApiClient } from '@/lib/api/client';
import { ROLE_NAMES, WORKSPACE_ROLES } from '../../model/workspace-roles';
import { workspaceMembersInfiniteQueryOptions } from '../../workspaces.queries';

type OverviewTarget =
  | '/w/$workspaceId/workflows'
  | '/w/$workspaceId/team'
  | '/w/$workspaceId/connections'
  | '/w/$workspaceId/alerts';

function counted(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/**
 * One thing that lives in the workspace: how many there are, in a large
 * figure, a line about them, and the whole tile opens their page.
 */
function OverviewTile({
  workspaceId,
  to,
  icon,
  label,
  count,
  more = false,
  loading,
  failed,
  children,
}: Readonly<{
  workspaceId: string;
  to: OverviewTarget;
  icon: ReactNode;
  label: string;
  count: number | undefined;
  /** More exist than were read: the figure is a floor, shown with "+". */
  more?: boolean;
  loading: boolean;
  failed: boolean;
  children?: ReactNode;
}>) {
  return (
    <Link
      to={to}
      params={{ workspaceId }}
      className="group flex min-h-36 flex-col rounded-xl border border-border bg-card/40 p-4 outline-none transition-colors duration-150 hover:border-border-strong hover:bg-card/70 focus-ring motion-reduce:transition-none"
    >
      <span className="flex items-center justify-between text-muted-foreground [&_svg]:size-4">
        {icon}
        <ArrowUpRightIcon
          aria-hidden="true"
          className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      </span>
      <span className="mt-3 flex items-baseline gap-2">
        {loading ? (
          <Skeleton className="h-8 w-10" />
        ) : (
          <span className="font-display text-4xl leading-none tabular-nums [--display-optical-size:32]">
            {failed || count === undefined ? '—' : String(count)}
            {more ? '+' : ''}
          </span>
        )}
        <span className="text-sm font-medium">{label}</span>
      </span>
      <span className="mt-auto pt-3 text-xs leading-relaxed text-muted-foreground">
        {failed ? 'Couldn’t count these just now.' : children}
      </span>
    </Link>
  );
}

function WorkflowsTile({
  apiClient,
  userId,
  workspaceId,
}: Readonly<{ apiClient: ApiClient; userId: string; workspaceId: string }>) {
  const query = useInfiniteQuery(
    workflowsInfiniteQueryOptions(apiClient, userId, workspaceId),
  );
  const workflows = query.data?.pages.flatMap((page) => page.items) ?? [];
  const active = workflows.filter(
    (workflow) => workflow.lifecycleStatus !== 'archived',
  );
  const archived = workflows.length - active.length;
  const states = countWorkflowStates(workflows);
  return (
    <OverviewTile
      workspaceId={workspaceId}
      to="/w/$workspaceId/workflows"
      icon={<WorkflowIcon aria-hidden="true" />}
      label={
        active.length === 1 && !query.hasNextPage ? 'workflow' : 'workflows'
      }
      count={active.length}
      more={query.hasNextPage}
      loading={query.isPending}
      failed={query.isError && query.data === undefined}
    >
      {states.length === 0 && archived === 0 ? (
        'None yet. Build the first one from Workflows.'
      ) : (
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          {states.map((state) => (
            <Status
              key={state.label}
              tone={state.tone}
              className="font-mono text-[0.72rem] font-normal"
            >
              {String(state.count)} {state.label}
            </Status>
          ))}
          {archived === 0 ? null : (
            <span className="font-mono text-[0.72rem]">
              {String(archived)} archived
            </span>
          )}
        </span>
      )}
    </OverviewTile>
  );
}

function MembersTile({
  apiClient,
  userId,
  workspaceId,
}: Readonly<{ apiClient: ApiClient; userId: string; workspaceId: string }>) {
  const query = useInfiniteQuery(
    workspaceMembersInfiniteQueryOptions(apiClient, userId, workspaceId),
  );
  const members = query.data?.pages.flatMap((page) => page.items) ?? [];
  // "1 Owner · 2 Builders": who's here, most powerful first.
  const byRole = WORKSPACE_ROLES.flatMap((role) => {
    const count = members.filter((member) => member.role === role).length;
    return count === 0
      ? []
      : [counted(count, ROLE_NAMES[role], `${ROLE_NAMES[role]}s`)];
  });
  const suspended = members.filter(
    (member) => member.membershipStatus === 'suspended',
  ).length;
  return (
    <OverviewTile
      workspaceId={workspaceId}
      to="/w/$workspaceId/team"
      icon={<UsersIcon aria-hidden="true" />}
      label={members.length === 1 && !query.hasNextPage ? 'member' : 'members'}
      count={members.length}
      more={query.hasNextPage}
      loading={query.isPending}
      failed={query.isError && query.data === undefined}
    >
      {[
        ...byRole,
        ...(suspended === 0 ? [] : [`${String(suspended)} suspended`]),
      ].join(' · ')}
    </OverviewTile>
  );
}

function ConnectionsTile({
  apiClient,
  userId,
  workspaceId,
}: Readonly<{ apiClient: ApiClient; userId: string; workspaceId: string }>) {
  const query = useInfiniteQuery(
    connectionsInfiniteQueryOptions(apiClient, userId, workspaceId),
  );
  const connections = (
    query.data?.pages.flatMap((page) => page.items) ?? []
  ).filter((connection) => connection.status !== 'revoked');
  const providers = [
    ...new Set(
      connections.map((connection) => PROVIDERS[connection.providerKey].name),
    ),
  ];
  const needsAttention = connections.filter(
    (connection) => connection.status === 'reauthorization_required',
  ).length;
  return (
    <OverviewTile
      workspaceId={workspaceId}
      to="/w/$workspaceId/connections"
      icon={<PlugIcon aria-hidden="true" />}
      label={
        connections.length === 1 && !query.hasNextPage
          ? 'connection'
          : 'connections'
      }
      count={connections.length}
      more={query.hasNextPage}
      loading={query.isPending}
      failed={query.isError && query.data === undefined}
    >
      {connections.length === 0 ? (
        'Nothing connected yet. Slack, HTTP APIs and email are ready to add.'
      ) : (
        <>
          {providers.join(' · ')}
          {needsAttention === 0 ? null : (
            <Status tone="attention" className="mt-1 text-xs font-normal">
              {counted(needsAttention, 'needs', 'need')} reconnecting
            </Status>
          )}
        </>
      )}
    </OverviewTile>
  );
}

function AlertsTile({
  apiClient,
  userId,
  workspaceId,
}: Readonly<{ apiClient: ApiClient; userId: string; workspaceId: string }>) {
  const query = useQuery(
    failureNotificationDestinationsQueryOptions(apiClient, userId, workspaceId),
  );
  const destinations = query.data?.items ?? [];
  const enabled = destinations.filter(
    (destination) => destination.status === 'enabled',
  ).length;
  const off = destinations.length - enabled;
  return (
    <OverviewTile
      workspaceId={workspaceId}
      to="/w/$workspaceId/alerts"
      icon={<BellIcon aria-hidden="true" />}
      label={
        destinations.length === 1 ? 'alert destination' : 'alert destinations'
      }
      count={destinations.length}
      loading={query.isPending}
      failed={query.isError && query.data === undefined}
    >
      {destinations.length === 0
        ? 'Failed runs aren’t announced anywhere yet.'
        : [
            `${String(enabled)} on`,
            ...(off === 0 ? [] : [`${String(off)} off`]),
          ].join(' · ')}
    </OverviewTile>
  );
}

/**
 * What lives in the workspace, each kind counted and one tap from its page.
 * A tile shows only when the role can open the page behind it.
 */
export function WorkspaceOverview({
  apiClient,
  userId,
  workspace,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  workspace: AccessibleWorkspace;
}>) {
  const can = (capability: AccessibleWorkspace['capabilities'][number]) =>
    workspace.capabilities.includes(capability);
  const scope = { apiClient, userId, workspaceId: workspace.id };
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {can('workflow:read') ? <WorkflowsTile {...scope} /> : null}
      {can('member:read') ? <MembersTile {...scope} /> : null}
      {can('connection:read') ? <ConnectionsTile {...scope} /> : null}
      {can('workflow:update') ? <AlertsTile {...scope} /> : null}
    </div>
  );
}
