import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  lazyRouteComponent,
  redirect,
} from '@tanstack/react-router';
import {
  workspaceIdentifierSchema,
  workspaceLifecycleOperationIdentifierSchema,
} from '@pertexo/contracts/schemas/identity-workspace';
import { workflowIdentifierSchema } from '@pertexo/contracts/schemas/workflow-authoring';
import { workflowRunIdentifierSchema } from '@pertexo/contracts/schemas/workflow-runs';
import type { ApiClient } from '@/lib/api/client';
import {
  currentUserQueryOptions,
  isUnauthenticated,
} from '@/features/auth/session.queries.public';
import { publishSessionChange } from '@/features/auth/session-sync.public';
import { accessibleWorkspacesQueryOptions } from '@/features/workspaces/queries.public';
import { workspaceMembersInfiniteQueryOptions } from '@/features/workspaces/members.queries.public';
import { workspaceLifecycleOperationQueryOptions } from '@/features/workspaces/lifecycle.queries.public';
import { authoringCatalogQueryOptions } from '@/features/catalog/public';
import {
  connectionDiscoveryQueryOptions,
  connectionsInfiniteQueryOptions,
} from '@/features/connections/queries.public';
import { failureNotificationDestinationsQueryOptions } from '@/features/failure-notifications/queries.public';
import {
  recentWorkflowsQueryOptions,
  workflowsInfiniteQueryOptions,
} from '@/features/workflows/queries.public';
import { workflowDraftQueryOptions } from '@/features/workflow-editor/draft.public';
import {
  recentWorkflowRunsQueryOptions,
  runHistorySearchSchema,
  workflowRunQueryOptions,
  workflowRunsInfiniteQueryOptions,
} from '@/features/workflow-runs/queries.public';
import {
  NotFoundPage,
  PendingPage,
  RootLayout,
  RouteError,
} from './root-layout';

type RouterContext = Readonly<{
  queryClient: QueryClient;
  apiClient: ApiClient;
}>;

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  errorComponent: RouteError,
  pendingComponent: PendingPage,
  notFoundComponent: NotFoundPage,
});

function rethrowError(error: unknown): never {
  if (error instanceof Error) throw error;
  throw new Error('An unexpected route failure occurred.', { cause: error });
}

async function clearAuthenticatedQueries(
  context: RouterContext,
): Promise<void> {
  await context.queryClient.cancelQueries();
  context.queryClient.clear();
}

async function loadCurrentUser(context: RouterContext) {
  const options = currentUserQueryOptions(context.apiClient);
  const previous = context.queryClient.getQueryData(options.queryKey);
  try {
    const current = await context.queryClient.query(options);
    if (previous !== undefined && previous.id !== current.id) {
      await clearAuthenticatedQueries(context);
      context.queryClient.setQueryData(options.queryKey, current);
      publishSessionChange();
    }
    return current;
  } catch (error) {
    if (isUnauthenticated(error)) {
      await clearAuthenticatedQueries(context);
      redirect({ to: '/login', throw: true });
    }
    rethrowError(error);
  }
}

async function loadWorkspaces(context: RouterContext, userId: string) {
  try {
    return await context.queryClient.query(
      accessibleWorkspacesQueryOptions(context.apiClient, userId),
    );
  } catch (error) {
    if (isUnauthenticated(error)) {
      await clearAuthenticatedQueries(context);
      redirect({ to: '/login', throw: true });
    }
    rethrowError(error);
  }
}

async function loadWorkspace(
  context: RouterContext,
  userId: string,
  workspaceId: string,
) {
  const parsedWorkspaceId = workspaceIdentifierSchema.safeParse(workspaceId);
  if (!parsedWorkspaceId.success) return null;
  const workspaces = await loadWorkspaces(context, userId);
  return (
    workspaces.find((candidate) => candidate.id === parsedWorkspaceId.data) ??
    null
  );
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  loader: async ({ context }) => {
    await loadCurrentUser(context);
    redirect({ to: '/workspaces', throw: true });
  },
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (search: Record<string, unknown>) => ({
    ...(search.verified === true || search.verified === 'true'
      ? { verified: true as const }
      : {}),
    ...(search.emailChanged === true || search.emailChanged === 'true'
      ? { emailChanged: true as const }
      : {}),
    ...(search.emailChangePending === true ||
    search.emailChangePending === 'true'
      ? { emailChangePending: true as const }
      : {}),
    ...(search.error === 'verification_invalid'
      ? { verificationInvalid: true as const }
      : {}),
    ...(search.error === 'link_reauthenticate'
      ? { linkReauthenticate: true as const }
      : {}),
    ...(search.error === 'migration_reauthenticate'
      ? { migrationReauthenticate: true as const }
      : {}),
    ...(search.error === 'migration_failed'
      ? { migrationFailed: true as const }
      : {}),
    ...(search.socialError === true || search.socialError === 'true'
      ? { socialError: true as const }
      : {}),
  }),
  beforeLoad: async ({ context }) => {
    try {
      await context.queryClient.query(
        currentUserQueryOptions(context.apiClient),
      );
    } catch (error) {
      if (isUnauthenticated(error)) {
        await clearAuthenticatedQueries(context);
        return;
      }
      rethrowError(error);
    }
    redirect({ to: '/workspaces', throw: true });
  },
  component: lazyRouteComponent(() => import('./login-route'), 'LoginRoute'),
});

const signUpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-up',
  component: lazyRouteComponent(() => import('./sign-up-route'), 'SignUpRoute'),
});

const legacyMigrationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account/migrate',
  component: lazyRouteComponent(
    () => import('./legacy-migration-route'),
    'LegacyMigrationRoute',
  ),
});

const passwordRecoveryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/forgot-password',
  component: lazyRouteComponent(
    () => import('./password-recovery-route'),
    'PasswordRecoveryRoute',
  ),
});

const passwordResetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reset-password',
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === 'string' ? search.token : undefined,
  }),
  loaderDeps: ({ search }) => ({
    token: search.token,
  }),
  loader: ({ deps }) => deps,
  component: lazyRouteComponent(
    () => import('./password-reset-route'),
    'PasswordResetRoute',
  ),
});

const logoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/logout',
  component: lazyRouteComponent(() => import('./logout-route'), 'LogoutRoute'),
});

const accountSecurityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account/security',
  validateSearch: (search: Record<string, unknown>) => ({
    ...(search.linked === true || search.linked === 'true'
      ? { linked: true as const }
      : {}),
    ...(search.linkError === true || search.linkError === 'true'
      ? { linkError: true as const }
      : {}),
  }),
  loader: async ({ context }) => loadCurrentUser(context),
  component: lazyRouteComponent(
    () => import('./account-security-route'),
    'AccountSecurityRoute',
  ),
});

const invitationAcceptanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invitations/accept',
  component: lazyRouteComponent(
    () => import('./invitation-acceptance-route'),
    'InvitationAcceptanceRoute',
  ),
});

const workspacesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspaces',
  loader: async ({ context }) => {
    const user = await loadCurrentUser(context);
    const workspaces = await loadWorkspaces(context, user.id);
    return { user, workspaces };
  },
  component: lazyRouteComponent(
    () => import('./workspace-selection-route'),
    'WorkspaceSelectionRoute',
  ),
});

const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$workspaceId/workflows',
  loader: async ({ context, params }) => {
    const user = await loadCurrentUser(context);
    const workspace = await loadWorkspace(context, user.id, params.workspaceId);
    if (workspace !== null) {
      const discoveries = await Promise.allSettled([
        context.queryClient.infiniteQuery(
          workflowsInfiniteQueryOptions(
            context.apiClient,
            user.id,
            workspace.id,
          ),
        ),
        context.queryClient.query(
          authoringCatalogQueryOptions(context.apiClient, user.id),
        ),
        context.queryClient.query(
          connectionDiscoveryQueryOptions(
            context.apiClient,
            user.id,
            workspace.id,
          ),
        ),
      ]);
      if (
        discoveries.some(
          (result) =>
            result.status === 'rejected' &&
            isUnauthenticated(result.reason as unknown),
        )
      ) {
        await clearAuthenticatedQueries(context);
        redirect({ to: '/login', throw: true });
      }
    }
    return { user, workspace };
  },
  component: lazyRouteComponent(
    () => import('./workflow-list-route'),
    'WorkflowListRoute',
  ),
});

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$workspaceId/overview',
  loader: async ({ context, params }) => {
    const user = await loadCurrentUser(context);
    const workspace = await loadWorkspace(context, user.id, params.workspaceId);
    if (workspace !== null) {
      const reads: Promise<unknown>[] = [];
      if (workspace.capabilities.includes('workflow:read'))
        reads.push(
          context.queryClient.query(
            recentWorkflowsQueryOptions(
              context.apiClient,
              user.id,
              workspace.id,
            ),
          ),
        );
      if (workspace.capabilities.includes('run:read'))
        reads.push(
          context.queryClient.query(
            recentWorkflowRunsQueryOptions(
              context.apiClient,
              user.id,
              workspace.id,
              'all',
            ),
          ),
          context.queryClient.query(
            recentWorkflowRunsQueryOptions(
              context.apiClient,
              user.id,
              workspace.id,
              'failed',
            ),
          ),
        );
      const results = await Promise.allSettled(reads);
      if (
        results.some(
          (result) =>
            result.status === 'rejected' &&
            isUnauthenticated(result.reason as unknown),
        )
      ) {
        await clearAuthenticatedQueries(context);
        redirect({ to: '/login', throw: true });
      }
    }
    return { user, workspace };
  },
  component: lazyRouteComponent(
    () => import('./overview-route'),
    'OverviewRoute',
  ),
});

const connectionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$workspaceId/connections',
  loader: async ({ context, params }) => {
    const user = await loadCurrentUser(context);
    const workspace = await loadWorkspace(context, user.id, params.workspaceId);
    if (workspace?.capabilities.includes('connection:read') === true) {
      try {
        await context.queryClient.infiniteQuery(
          connectionsInfiniteQueryOptions(
            context.apiClient,
            user.id,
            workspace.id,
          ),
        );
      } catch (error) {
        if (isUnauthenticated(error)) {
          await clearAuthenticatedQueries(context);
          redirect({ to: '/login', throw: true });
        }
      }
    }
    return { user, workspace };
  },
  component: lazyRouteComponent(
    () => import('./connections-route'),
    'ConnectionsRoute',
  ),
});

const workflowEditorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$workspaceId/workflows/$workflowId',
  loader: async ({ context, params }) => {
    const user = await loadCurrentUser(context);
    const parsedWorkflowId = workflowIdentifierSchema.safeParse(
      params.workflowId,
    );
    if (!parsedWorkflowId.success) return { user, workspace: null };
    const workspace = await loadWorkspace(context, user.id, params.workspaceId);
    if (workspace !== null) {
      try {
        await Promise.all([
          context.queryClient.query(
            workflowDraftQueryOptions(
              context.apiClient,
              user.id,
              workspace.id,
              parsedWorkflowId.data,
            ),
          ),
          context.queryClient.query(
            authoringCatalogQueryOptions(context.apiClient, user.id),
          ),
          context.queryClient.query(
            connectionDiscoveryQueryOptions(
              context.apiClient,
              user.id,
              workspace.id,
            ),
          ),
        ]);
      } catch (error) {
        if (isUnauthenticated(error)) {
          await clearAuthenticatedQueries(context);
          redirect({ to: '/login', throw: true });
        }
        rethrowError(error);
      }
    }
    return { user, workspace };
  },
  component: lazyRouteComponent(
    () => import('./workflow-editor-route'),
    'WorkflowEditorRoute',
  ),
});

const runDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$workspaceId/runs/$runId',
  loader: async ({ context, params }) => {
    const user = await loadCurrentUser(context);
    const parsedRunId = workflowRunIdentifierSchema.safeParse(params.runId);
    if (!parsedRunId.success) return { user, workspace: null };
    const workspace = await loadWorkspace(context, user.id, params.workspaceId);
    if (workspace !== null) {
      try {
        await context.queryClient.query(
          workflowRunQueryOptions(
            context.apiClient,
            user.id,
            workspace.id,
            parsedRunId.data,
          ),
        );
      } catch (error) {
        if (isUnauthenticated(error)) {
          await clearAuthenticatedQueries(context);
          redirect({ to: '/login', throw: true });
        }
        rethrowError(error);
      }
    }
    return { user, workspace };
  },
  component: lazyRouteComponent(
    () => import('./run-detail-route'),
    'RunDetailRoute',
  ),
});

const runHistoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$workspaceId/runs',
  validateSearch: (search) => runHistorySearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ context, params, deps }) => {
    const user = await loadCurrentUser(context);
    const workspace = await loadWorkspace(context, user.id, params.workspaceId);
    if (workspace?.capabilities.includes('run:read') === true) {
      try {
        await context.queryClient.infiniteQuery(
          workflowRunsInfiniteQueryOptions(
            context.apiClient,
            user.id,
            workspace.id,
            deps,
          ),
        );
      } catch (error) {
        if (isUnauthenticated(error)) {
          await clearAuthenticatedQueries(context);
          redirect({ to: '/login', throw: true });
        }
      }
    }
    return { user, workspace };
  },
  component: lazyRouteComponent(
    () => import('./run-history-route'),
    'RunHistoryRoute',
  ),
});

const workflowSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$workspaceId/workflows/$workflowId/settings',
  loader: async ({ context, params }) => {
    const user = await loadCurrentUser(context);
    const parsedWorkflowId = workflowIdentifierSchema.safeParse(
      params.workflowId,
    );
    if (!parsedWorkflowId.success) return { user, workspace: null };
    const workspace = await loadWorkspace(context, user.id, params.workspaceId);
    return { user, workspace };
  },
  component: lazyRouteComponent(
    () => import('./workflow-settings-route'),
    'WorkflowSettingsRoute',
  ),
});

const workspaceMembersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$workspaceId/settings/members',
  loader: async ({ context, params }) => {
    const user = await loadCurrentUser(context);
    const workspace = await loadWorkspace(context, user.id, params.workspaceId);
    if (workspace?.capabilities.includes('member:read') === true) {
      try {
        await context.queryClient.infiniteQuery(
          workspaceMembersInfiniteQueryOptions(
            context.apiClient,
            user.id,
            workspace.id,
          ),
        );
      } catch (error) {
        if (isUnauthenticated(error)) {
          await clearAuthenticatedQueries(context);
          redirect({ to: '/login', throw: true });
        }
      }
    }
    return { user, workspace };
  },
  component: lazyRouteComponent(
    () => import('./workspace-members-route'),
    'WorkspaceMembersRoute',
  ),
});

const workspaceGeneralRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$workspaceId/settings/general',
  validateSearch: (search) => {
    const parsed = workspaceLifecycleOperationIdentifierSchema.safeParse(
      Reflect.get(search, 'operationId'),
    );
    return parsed.success ? { operationId: parsed.data } : {};
  },
  loaderDeps: ({ search }) => search,
  loader: async ({ context, params, deps }) => {
    const user = await loadCurrentUser(context);
    const workspace = await loadWorkspace(context, user.id, params.workspaceId);
    if (
      workspace?.capabilities.includes('workspace:manage') === true &&
      deps.operationId !== undefined
    ) {
      try {
        await context.queryClient.query(
          workspaceLifecycleOperationQueryOptions(
            context.apiClient,
            user.id,
            workspace.id,
            deps.operationId,
          ),
        );
      } catch (error) {
        if (isUnauthenticated(error)) {
          await clearAuthenticatedQueries(context);
          redirect({ to: '/login', throw: true });
        }
      }
    }
    return { user, workspace };
  },
  component: lazyRouteComponent(
    () => import('./workspace-general-route'),
    'WorkspaceGeneralRoute',
  ),
});

const workspaceNotificationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$workspaceId/settings/notifications',
  loader: async ({ context, params }) => {
    const user = await loadCurrentUser(context);
    const workspace = await loadWorkspace(context, user.id, params.workspaceId);
    if (workspace?.capabilities.includes('workflow:update') === true) {
      const reads: Promise<unknown>[] = [
        context.queryClient.query(
          failureNotificationDestinationsQueryOptions(
            context.apiClient,
            user.id,
            workspace.id,
          ),
        ),
      ];
      if (
        workspace.capabilities.includes('connection:manage') &&
        workspace.capabilities.includes('connection:read')
      )
        reads.push(
          context.queryClient.query(
            connectionDiscoveryQueryOptions(
              context.apiClient,
              user.id,
              workspace.id,
            ),
          ),
        );
      try {
        await Promise.all(reads);
      } catch (error) {
        if (isUnauthenticated(error)) {
          await clearAuthenticatedQueries(context);
          redirect({ to: '/login', throw: true });
        }
      }
    }
    return { user, workspace };
  },
  component: lazyRouteComponent(
    () => import('./workspace-notifications-route'),
    'WorkspaceNotificationsRoute',
  ),
});

export const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  signUpRoute,
  legacyMigrationRoute,
  passwordRecoveryRoute,
  passwordResetRoute,
  logoutRoute,
  accountSecurityRoute,
  invitationAcceptanceRoute,
  workspacesRoute,
  workspaceRoute,
  overviewRoute,
  connectionsRoute,
  workflowEditorRoute,
  runHistoryRoute,
  runDetailRoute,
  workflowSettingsRoute,
  workspaceGeneralRoute,
  workspaceMembersRoute,
  workspaceNotificationsRoute,
]);
