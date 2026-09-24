import {
  createRoute,
  lazyRouteComponent,
  redirect,
} from '@tanstack/react-router';
import {
  currentUserQueryOptions,
  isUnauthenticated,
} from '@/features/auth/session.queries.public';
import { rootRoute } from './root-route';
import {
  clearAuthenticatedQueries,
  loadCurrentUser,
  rethrowError,
} from './route-loaders';

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  loader: async ({ context }) => {
    await loadCurrentUser(context);
    redirect({ to: '/workspaces', throw: true });
  },
});

export const loginRoute = createRoute({
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

export const signUpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sign-up',
  component: lazyRouteComponent(() => import('./sign-up-route'), 'SignUpRoute'),
});

export const legacyMigrationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account/migrate',
  component: lazyRouteComponent(
    () => import('./legacy-migration-route'),
    'LegacyMigrationRoute',
  ),
});

export const passwordRecoveryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/forgot-password',
  component: lazyRouteComponent(
    () => import('./password-recovery-route'),
    'PasswordRecoveryRoute',
  ),
});

export const passwordResetRoute = createRoute({
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

export const logoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/logout',
  component: lazyRouteComponent(() => import('./logout-route'), 'LogoutRoute'),
});

export const accountSecurityRoute = createRoute({
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

export const invitationAcceptanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invitations/accept',
  component: lazyRouteComponent(
    () => import('./invitation-acceptance-route'),
    'InvitationAcceptanceRoute',
  ),
});
