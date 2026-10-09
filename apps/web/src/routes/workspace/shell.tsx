import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { Outlet, useMatchRoute } from '@tanstack/react-router';
import { useNotifications } from '@/components/ui/use-notifications';
import {
  InboxArrivals,
  type InboxArrivalAnchor,
} from '@/features/inbox/arrival.public';
import { useInboxLive } from '@/features/inbox/live.public';
import { inboxSummaryQueryOptions } from '@/features/inbox/queries.public';
import { liveRunCountQueryOptions } from '@/features/workflow-runs/queries.public';
import { rememberLastWorkspace } from '@/features/workspaces/last-workspace.public';
import { WorkspaceShell } from '@/features/workspaces/public';
import { accessibleWorkspacesQueryOptions } from '@/features/workspaces/queries.public';
import { useShellCrumbs, type Crumb } from '../root/breadcrumbs';
import { CommandPaletteContext } from './command-palette-context';
import { useLogout } from '../auth/use-logout';
import { useWorkspaceScope } from './use-workspace-scope';
import { WorkspaceCommandPalette } from './command-palette';

function useCommandShortcut(onOpen: () => void) {
  const open = useEffectEvent(onOpen);
  useEffect(() => {
    function listen(event: KeyboardEvent) {
      if (
        event.key.toLowerCase() === 'k' &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey
      ) {
        event.preventDefault();
        open();
      }
    }
    window.addEventListener('keydown', listen);
    return () => {
      window.removeEventListener('keydown', listen);
    };
  }, []);
}

/** A destination hidden by the layout (the spine on a phone) has no boxes. */
function isShown(element: Element | null): element is Element {
  return element !== null && element.getClientRects().length > 0;
}

/**
 * The Inbox destination that new-failure notices hang from: on the spine they
 * open to its right, on the phone bar above it.
 */
function useInboxAnchors() {
  const spine = useRef<HTMLAnchorElement>(null);
  const bar = useRef<HTMLAnchorElement>(null);
  const find = useCallback((): InboxArrivalAnchor | undefined => {
    if (isShown(spine.current))
      return { element: spine.current, side: 'right' };
    if (isShown(bar.current)) return { element: bar.current, side: 'top' };
    return undefined;
  }, []);
  return { refs: { spine, bar }, find };
}

/**
 * The spine, breadcrumb, banners and ⌘K around a workspace page. Pages under
 * the shell route get it from the layout; a page outside it (a missing
 * workflow) renders it around itself with its own `crumbs`.
 */
export function WorkspaceShellFrame({
  crumbs,
  children,
}: Readonly<{ crumbs?: readonly Crumb[]; children: ReactNode }>) {
  const { apiClient, user, workspace } = useWorkspaceScope();
  const notifications = useNotifications();
  const logout = useLogout(apiClient, {
    onError: (message) => {
      notifications.error({
        title: 'Sign-out didn’t finish',
        description: message,
      });
    },
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const canReadRuns = workspace.capabilities.includes('run:read');
  const workspaces = useQuery(
    accessibleWorkspacesQueryOptions(apiClient, user.id),
  );
  const liveRunCount = useQuery({
    ...liveRunCountQueryOptions(apiClient, user.id, workspace.id),
    enabled: canReadRuns,
  });
  const canReadInbox = workspace.capabilities.includes('notification:read');
  const inboxSummary = useQuery({
    ...inboxSummaryQueryOptions(apiClient, user.id, workspace.id),
    enabled: canReadInbox,
  });
  // One live inbox stream per tab keeps the badge and the inbox current.
  useInboxLive(apiClient, user.id, workspace.id, canReadInbox);
  const inboxAnchors = useInboxAnchors();
  const matchRoute = useMatchRoute();
  const onInboxPage =
    matchRoute({
      to: '/w/$workspaceId/inbox',
      params: { workspaceId: workspace.id },
      fuzzy: true,
    }) !== false;
  const routeCrumbs = useShellCrumbs(workspace);

  // Stable, so pages that receive it through context don't re-render.
  const openSearch = useCallback(() => {
    setSearchOpen(true);
  }, []);
  useCommandShortcut(openSearch);

  useEffect(() => {
    rememberLastWorkspace(user.id, { id: workspace.id, name: workspace.name });
  }, [user.id, workspace.id, workspace.name]);

  return (
    <WorkspaceShell
      user={user}
      workspace={workspace}
      workspaces={workspaces.data ?? [workspace]}
      liveRunCount={canReadRuns ? liveRunCount.data : undefined}
      unreadNoticeCount={
        canReadInbox ? inboxSummary.data?.unreadCount : undefined
      }
      inboxRefs={inboxAnchors.refs}
      crumbs={crumbs ?? routeCrumbs}
      logoutPending={logout.pending}
      onLogout={logout.requestLogout}
      onOpenSearch={openSearch}
    >
      <CommandPaletteContext value={openSearch}>
        {children}
      </CommandPaletteContext>
      <WorkspaceCommandPalette
        open={searchOpen}
        onOpenChange={setSearchOpen}
        workspaces={workspaces.data ?? [workspace]}
        onLogout={logout.requestLogout}
      />
      {canReadInbox ? (
        <InboxArrivals
          scope={{ apiClient, userId: user.id, workspaceId: workspace.id }}
          summary={inboxSummary.data}
          quiet={onInboxPage}
          findAnchor={inboxAnchors.find}
        />
      ) : null}
    </WorkspaceShell>
  );
}

export function WorkspaceShellRoute() {
  return (
    <WorkspaceShellFrame>
      <Outlet />
    </WorkspaceShellFrame>
  );
}
