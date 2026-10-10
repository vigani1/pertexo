import {
  createRoute,
  lazyRouteComponent,
  redirect,
} from '@tanstack/react-router';
import {
  allowlistedReturnPath,
  returnToSearch,
} from '@/features/auth/return-path.public';
import { landingWorkspace } from '@/features/workspaces/last-workspace.public';
import { pageTitle } from './page-title';
import {
  findCurrentUser,
  loadCurrentUser,
  loadWorkspaces,
} from './route-context';
import { rootRoute } from './route';
import { AuthLensPending } from '../auth/lens-pending';
import { AuthStageRoute } from '../auth/stage';
import { BootPage, OpeningPage } from './status/pages';

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
  // Loaded with the app, so a cold visit paints the stage at once and only
  // the lens waits, instead of a boot screen that then cuts to the stage.
  component: AuthStageRoute,
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
    ...returnToSearch(allowlistedReturnPath(search.returnTo)),
  }),
  beforeLoad: async ({ context, search }) => {
    const user = await findCurrentUser(context);
    if (user === undefined) return;
    // Router search keeps unvalidated raw keys, so check the value again.
    const safeReturnPath = allowlistedReturnPath(search.returnTo);
    if (safeReturnPath === undefined) redirect({ to: '/', throw: true });
    else redirect({ href: safeReturnPath, throw: true });
  },
  head: () => ({ meta: [{ title: pageTitle('Sign in') }] }),
  component: lazyRouteComponent(() => import('../auth/login'), 'LoginRoute'),
});

export const signUpRoute = createRoute({
  getParentRoute: () => authStageRoute,
  path: 'sign-up',
  pendingComponent: AuthLensPending,
  validateSearch: (search: Record<string, unknown>) =>
    returnToSearch(allowlistedReturnPath(search.returnTo)),
  head: () => ({ meta: [{ title: pageTitle('Create account') }] }),
  component: lazyRouteComponent(() => import('../auth/sign-up'), 'SignUpRoute'),
});

export const passwordRecoveryRoute = createRoute({
  getParentRoute: () => authStageRoute,
  path: 'forgot-password',
  pendingComponent: AuthLensPending,
  head: () => ({ meta: [{ title: pageTitle('Reset password') }] }),
  component: lazyRouteComponent(
    () => import('../auth/password-recovery'),
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
    () => import('../auth/password-reset'),
    'PasswordResetRoute',
  ),
});

export const logoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/logout',
  pendingComponent: OpeningPage,
  validateSearch: (search: Record<string, unknown>) =>
    returnToSearch(allowlistedReturnPath(search.returnTo)),
  head: () => ({ meta: [{ title: pageTitle('Signing out') }] }),
  component: lazyRouteComponent(() => import('../auth/logout'), 'LogoutRoute'),
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
    () => import('../auth/account-security'),
    'AccountSecurityRoute',
  ),
});

export const invitationAcceptanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invitations/accept',
  pendingComponent: BootPage,
  head: () => ({ meta: [{ title: pageTitle('Workspace invitation') }] }),
  component: lazyRouteComponent(
    () => import('../auth/invitation-acceptance'),
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
    () => import('../workspace/selection'),
    'WorkspaceSelectionRoute',
  ),
});
