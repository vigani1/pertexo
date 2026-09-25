import type { InvitationAcceptanceJourney } from '@pertexo/contracts/schemas/identity-workspace';
import {
  AuthLens,
  AuthLensTitle,
  AuthStage,
  LensLoading,
} from '@/features/auth/auth-stage.public';
import type { ApiClient } from '@/lib/api/client';
import { AcceptanceFailureLine } from './components/acceptance-failure-line';
import { CompletedJourney } from './components/completed-journey';
import {
  DeadEndJourney,
  ReadyJourney,
  SignInJourney,
  WrongAccountJourney,
} from './components/journey-states';
import { isDeadEnd } from './model/journey-copy';
import type { InvitationSignInMethod } from './model/sign-in-method';
import { useInvitationJourney } from './use-invitation-journey';

type InvitationAcceptancePageProps = Readonly<{
  apiClient: ApiClient;
  initialToken?: string;
  /** How the invited account is proven (ADR 043). */
  signInMethod: InvitationSignInMethod;
  clearFragment: () => void;
  navigateToProvider: (url: string) => void;
  openWorkspace: (workspaceId: string) => void;
  /** Sign in and come back to this invitation. */
  openSignIn: () => void;
  /** Sign in again with a fresh session and come back. */
  openFreshSignIn?: () => void;
  openSignUp?: () => void;
  openWorkspaceDiscovery: () => void;
  /** How long "Opening…" waits after joining; injectable for tests. */
  autoOpenAfterMs?: number;
}>;

export function InvitationAcceptancePage({
  apiClient,
  initialToken,
  signInMethod,
  clearFragment,
  navigateToProvider,
  openWorkspace,
  openSignIn,
  openFreshSignIn = openSignIn,
  openSignUp = openSignIn,
  openWorkspaceDiscovery,
  autoOpenAfterMs = 3_000,
}: InvitationAcceptancePageProps) {
  const journey = useInvitationJourney({
    apiClient,
    routeToken: initialToken,
    signInMethod,
    clearFragment,
    navigateToProvider,
    openSignIn,
    openFreshSignIn,
    openWorkspace,
    openWorkspaceDiscovery,
  });
  const current = journey.journey;

  if (current === undefined && journey.error === undefined)
    return (
      <AuthStage layout="centered">
        <LensLoading
          title="Workspace invitation"
          label="Checking your invitation…"
        />
      </AuthStage>
    );

  return (
    <AuthStage layout="centered">
      <AuthLens pending={journey.pending} aria-labelledby="invitation-title">
        {current === undefined ? (
          <AuthLensTitle id="invitation-title">
            Workspace invitation
          </AuthLensTitle>
        ) : (
          <JourneyContent
            apiClient={apiClient}
            journey={current}
            pending={journey.pending}
            cleanupFailed={journey.error?.kind === 'cleanup'}
            onAccept={journey.accept}
            onNotNow={journey.setAside}
            onSignIn={journey.signIn}
            onSwitchAccount={journey.switchAccount}
            onCreateAccount={openSignUp}
            onOpenCompleted={journey.openCompleted}
            autoOpenAfterMs={autoOpenAfterMs}
            onSignInNormally={openSignIn}
            onDiscover={openWorkspaceDiscovery}
          />
        )}
        {journey.error === undefined ? null : (
          <AcceptanceFailureLine
            error={journey.error}
            journey={current}
            pending={journey.pending}
            tokenAvailable={journey.tokenAvailable}
            onReconcile={journey.reconcile}
            onSignIn={journey.signIn}
            onOpenWorkspace={openWorkspace}
            onDiscover={openWorkspaceDiscovery}
            onRetry={journey.retry}
          />
        )}
      </AuthLens>
    </AuthStage>
  );
}

function JourneyContent({
  apiClient,
  journey,
  pending,
  cleanupFailed,
  onAccept,
  onNotNow,
  onSignIn,
  onSwitchAccount,
  onCreateAccount,
  onOpenCompleted,
  autoOpenAfterMs,
  onSignInNormally,
  onDiscover,
}: Readonly<{
  apiClient: ApiClient;
  journey: InvitationAcceptanceJourney;
  pending: boolean;
  cleanupFailed: boolean;
  onAccept: () => void;
  onNotNow: () => void;
  onSignIn: () => void;
  onSwitchAccount: () => void;
  onCreateAccount: () => void;
  onOpenCompleted: (workspaceId: string, csrfToken: string) => void;
  autoOpenAfterMs: number;
  onSignInNormally: () => void;
  onDiscover: () => void;
}>) {
  switch (journey.state) {
    case 'ready':
      return (
        <ReadyJourney
          journey={journey}
          pending={pending}
          onAccept={onAccept}
          onNotNow={onNotNow}
        />
      );
    case 'completed':
      return (
        <CompletedJourney
          key={journey.intentId}
          journey={journey}
          pending={pending}
          cleanupFailed={cleanupFailed}
          autoOpenAfterMs={autoOpenAfterMs}
          onOpen={() => {
            onOpenCompleted(journey.workspace.id, journey.csrfToken);
          }}
        />
      );
    case 'sign_in_required':
      return (
        <SignInJourney
          pending={pending}
          onSignIn={onSignIn}
          onCreateAccount={onCreateAccount}
        />
      );
    case 'wrong_account':
      return (
        <WrongAccountJourney
          apiClient={apiClient}
          pending={pending}
          onSwitchAccount={onSwitchAccount}
          onDiscover={onDiscover}
        />
      );
    default:
      return isDeadEnd(journey.state) ? (
        <DeadEndJourney
          state={journey.state}
          onDiscover={onDiscover}
          {...(journey.state === 'unavailable'
            ? { onSignIn: onSignInNormally }
            : {})}
        />
      ) : null;
  }
}
