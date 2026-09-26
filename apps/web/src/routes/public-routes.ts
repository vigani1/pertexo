import {
  createRoute,
  lazyRouteComponent,
  redirect,
} from '@tanstack/react-router';
import {
  returnPathFrom,
  returnToSearch,
} from '@/features/auth/return-path.public';
import { authenticationCapabilitiesQueryOptions } from '@/features/auth/queries.public';
import { invitationSignInMethod } from '@/features/workspace-invitations/public';
import { landingWorkspace } from '@/features/workspaces/last-workspace.public';
import { pageTitle } from './page-title';
import {
  findCurrentUser,
  loadCurrentUser,
  loadWorkspaces,
} from './route-context';
import { rootRoute } from './root-route';
import { AuthLensPending } from './auth-lens-pending';
import { BootPage, OpeningPage } from './system-pages';

function flag(value: unknown): boolean {
  return value === true || value === 'true';
}

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  pendingComponent: BootPage,
  loader: async ({ context }) => {
    const user = await loadCurrentUser(context);
    const workspaces = await loadWorkspaces(context, user.id);
    const landing = landingWorkspace(user.id, workspaces);
    if (landing === undefined)
      return redirect({ to: '/workspaces', throw: true });
    return redirect({
      to: '/w/$workspaceId',
      params: { workspaceId: landing.id },
      throw: true,
    });
  },
});

/**
 * The sign-in family shares one stage: moving between its pages swaps only
 * the lens, so the Core and its threads never blank and restart.
 */
export const authStageRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_stage',
  pendingComponent: OpeningPage,
  component: lazyRouteComponent(
    () => import('./auth-stage-route'),
    'AuthStageRoute',
  ),
});

export const loginRoute = createRoute({
  getParentRoute: () => authStageRoute,
  path: 'login',
  pendingComponent: AuthLensPending,
  validateSearch: (search: Record<string, unknown>) => ({
    ...(flag(search.verified) ? { verified: true as const } : {}),
    ...(flag(search.emailChanged) ? { emailChanged: true as const } : {}),
    ...(flag(search.emailChangePending)
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
    ...(flag(search.socialError) ? { socialError: true as const } : {}),
    ...returnToSearch(returnPathFrom(search.returnTo)),
  }),
  beforeLoad: async ({ context, search }) => {
    const user = await findCurrentUser(context);
    if (user === undefined) return;
    // Router search keeps unvalidated raw keys, so check the value again.
    const returnTo = returnPathFrom(search.returnTo);
    if (returnTo === undefined) redirect({ to: '/', throw: true });
    else redirect({ href: returnTo, throw: true });
  },
  head: () => ({ meta: [{ title: pageTitle('Sign in') }] }),
  component: lazyRouteComponent(() => import('./login-route'), 'LoginRoute'),
});

export const signUpRoute = createRoute({
  getParentRoute: () => authStageRoute,
  path: 'sign-up',
  pendingComponent: AuthLensPending,
  validateSearch: (search: Record<string, unknown>) =>
    returnToSearch(returnPathFrom(search.returnTo)),
  head: () => ({ meta: [{ title: pageTitle('Create account') }] }),
  component: lazyRouteComponent(() => import('./sign-up-route'), 'SignUpRoute'),
});

export const legacyMigrationRoute = createRoute({
  getParentRoute: () => authStageRoute,
  path: 'account/migrate',
  pendingComponent: AuthLensPending,
  head: () => ({ meta: [{ title: pageTitle('Move your sign-in') }] }),
  component: lazyRouteComponent(
    () => import('./legacy-migration-route'),
    'LegacyMigrationRoute',
  ),
});

export const passwordRecoveryRoute = createRoute({
  getParentRoute: () => authStageRoute,
  path: 'forgot-password',
  pendingComponent: AuthLensPending,
  head: () => ({ meta: [{ title: pageTitle('Reset password') }] }),
  component: lazyRouteComponent(
    () => import('./password-recovery-route'),
    'PasswordRecoveryRoute',
  ),
});

export const passwordResetRoute = createRoute({
  getParentRoute: () => authStageRoute,
  path: 'reset-password',
  pendingComponent: AuthLensPending,
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === 'string' ? search.token : undefined,
  }),
  loaderDeps: ({ search }) => ({ token: search.token }),
  loader: ({ deps }) => deps,
  head: () => ({ meta: [{ title: pageTitle('Choose a new password') }] }),
  component: lazyRouteComponent(
    () => import('./password-reset-route'),
    'PasswordResetRoute',
  ),
});

export const logoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/logout',
  pendingComponent: OpeningPage,
  validateSearch: (search: Record<string, unknown>) =>
    returnToSearch(returnPathFrom(search.returnTo)),
  head: () => ({ meta: [{ title: pageTitle('Signing out') }] }),
  component: lazyRouteComponent(() => import('./logout-route'), 'LogoutRoute'),
});

// Standalone account page: the target of sign-in method link callbacks.
export const accountSecurityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account/security',
  pendingComponent: BootPage,
  validateSearch: (search: Record<string, unknown>) => ({
    ...(flag(search.linked) ? { linked: true as const } : {}),
    ...(flag(search.linkError) ? { linkError: true as const } : {}),
  }),
  loader: async ({ context }) => loadCurrentUser(context),
  head: () => ({ meta: [{ title: pageTitle('Account & security') }] }),
  component: lazyRouteComponent(
    () => import('./account-security-route'),
    'AccountSecurityRoute',
  ),
});

export const invitationAcceptanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invitations/accept',
  pendingComponent: BootPage,
  // Unreadable capabilities fall back to the session authority's sign-in.
  loader: async ({ context }) => ({
    signInMethod: invitationSignInMethod(
      await context.queryClient
        .query(authenticationCapabilitiesQueryOptions(context.apiClient))
        .catch(() => undefined),
    ),
  }),
  head: () => ({ meta: [{ title: pageTitle('Workspace invitation') }] }),
  component: lazyRouteComponent(
    () => import('./invitation-acceptance-route'),
    'InvitationAcceptanceRoute',
  ),
});

export const workspacesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workspaces',
  pendingComponent: BootPage,
  loader: async ({ context }) => {
    const user = await loadCurrentUser(context);
    const workspaces = await loadWorkspaces(context, user.id);
    return { user, workspaces };
  },
  head: () => ({ meta: [{ title: pageTitle('Workspaces') }] }),
  component: lazyRouteComponent(
    () => import('./workspace-selection-route'),
    'WorkspaceSelectionRoute',
  ),
});
