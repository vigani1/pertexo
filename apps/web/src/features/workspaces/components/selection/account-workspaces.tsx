import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRightIcon } from 'lucide-react';
import { SettingsSection } from '@/components/patterns/settings-section';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Status } from '@/components/ui/status';
import type { ApiClient } from '@/lib/api/client';
import { readFailureReason } from '@/lib/api/api-error-copy';
import { ROLE_NAMES } from '../../model/workspace-roles';
import { accessibleWorkspacesQueryOptions } from '../../workspaces.queries';
import { WorkspaceMark } from '../shell/workspace-mark';

/**
 * Every workspace the person belongs to, with their role in each, for the
 * account page: a person is one account across all of them.
 */
export function AccountWorkspacesSection({
  apiClient,
  userId,
  currentWorkspaceId,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  /** The workspace the page is open in, if any. */
  currentWorkspaceId?: string;
}>) {
  const query = useQuery(accessibleWorkspacesQueryOptions(apiClient, userId));
  const workspaces = query.data ?? [];
  return (
    <SettingsSection
      title="Your workspaces"
      description="Where you’re a member, and your role in each. Roles are set by each workspace’s admins."
    >
      {query.isPending ? (
        <div role="status" className="flex flex-col gap-3">
          <span className="sr-only">Loading your workspaces…</span>
          {[0, 1].map((row) => (
            <div key={row} className="flex items-center gap-3">
              <Skeleton className="size-9 rounded-lg" />
              <Skeleton className="h-3 w-40" />
            </div>
          ))}
        </div>
      ) : query.isError && query.data === undefined ? (
        <p className="text-sm text-muted-foreground">
          {readFailureReason(query.error)}
        </p>
      ) : workspaces.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          You aren’t a member of any workspace yet.
        </p>
      ) : (
        <ul className="flex flex-col">
          {workspaces.map((workspace) => (
            <li
              key={workspace.id}
              className="border-t border-border first:border-t-0"
            >
              <Link
                to="/w/$workspaceId"
                params={{ workspaceId: workspace.id }}
                className="group flex min-h-14 items-center gap-3 rounded-md px-1 py-2 outline-none transition-colors hover:bg-white/[0.03] focus-ring"
              >
                <WorkspaceMark
                  name={workspace.name}
                  className="size-9 rounded-lg text-[0.7rem]"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-semibold">
                      {workspace.name}
                    </span>
                    {workspace.id === currentWorkspaceId ? (
                      <Badge variant="muted">Open now</Badge>
                    ) : null}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {ROLE_NAMES[workspace.role]}
                  </span>
                </span>
                {workspace.status === 'pending_deletion' ? (
                  <Status tone="attention" className="text-xs font-normal">
                    Deletion pending
                  </Status>
                ) : null}
                <ChevronRightIcon
                  aria-hidden="true"
                  className="size-4 text-subtle-foreground transition-transform group-hover:translate-x-0.5"
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}
