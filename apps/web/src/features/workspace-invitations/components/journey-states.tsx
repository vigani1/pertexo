import type { InvitationAcceptanceJourney } from '@pertexo/contracts/schemas/identity-workspace';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { StatusGlyph } from '@/components/ui/status';
import {
  AuthLensDescription,
  AuthLensTitle,
} from '@/features/auth/auth-stage.public';
import { ProgressButton } from '@/components/ui/progress-button';
import { currentUserQueryOptions } from '@/features/auth/queries.public';
import type { ApiClient } from '@/lib/api/client';
import { DEAD_END_COPY, type DeadEndState } from '../model/journey-copy';
import { InvitationHeading } from './invitation-heading';

type Ready = Extract<InvitationAcceptanceJourney, { state: 'ready' }>;

export function ReadyJourney({
  journey,
  pending,
  onAccept,
  onNotNow,
}: Readonly<{
  journey: Ready;
  pending: boolean;
  onAccept: () => void;
  onNotNow: () => void;
}>) {
  return (
    <>
      <InvitationHeading
        workspaceName={journey.workspace.name}
        role={journey.role}
      >
        Join {journey.workspace.name}
      </InvitationHeading>
      {journey.sessionRotationRequired ? (
        <AuthLensDescription className="mt-5 text-center">
          Accepting signs you out of Pertexo on your other devices.
        </AuthLensDescription>
      ) : null}
      <div className="mt-6 flex flex-col gap-2">
        <ProgressButton
          type="button"
          variant="primary"
          size="lg"
          className="w-full"
          pending={pending}
          pendingLabel="Joining…"
          onClick={onAccept}
        >
          Accept and open workspace
        </ProgressButton>
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={onNotNow}
        >
          Not now
        </Button>
      </div>
    </>
  );
}

function JourneyTitle({ children }: Readonly<{ children: string }>) {
  return (
    <AuthLensTitle id="invitation-title" className="text-balance">
      {children}
    </AuthLensTitle>
  );
}

export function SignInJourney({
  pending,
  onSignIn,
  onCreateAccount,
}: Readonly<{
  pending: boolean;
  onSignIn: () => void;
  onCreateAccount: () => void;
}>) {
  return (
    <>
      <JourneyTitle>Accept your invitation</JourneyTitle>
      <AuthLensDescription>
        Sign in with the email address this invitation was sent to. You come
        back here to accept.
      </AuthLensDescription>
      <div className="mt-6 flex flex-col gap-2">
        <ProgressButton
          type="button"
          variant="primary"
          size="lg"
          className="w-full"
          pending={pending}
          pendingLabel="Opening sign-in…"
          onClick={onSignIn}
        >
          Sign in to accept
        </ProgressButton>
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={onCreateAccount}
        >
          New to Pertexo? Create an account
        </Button>
      </div>
    </>
  );
}

function SignedInEmail({ apiClient }: Readonly<{ apiClient: ApiClient }>) {
  const user = useQuery(currentUserQueryOptions(apiClient));
  if (user.data === undefined)
    return <>You’re signed in with a different account</>;
  return (
    <>
      You’re signed in as{' '}
      <strong className="font-semibold text-foreground [overflow-wrap:anywhere]">
        {user.data.email}
      </strong>
    </>
  );
}

export function WrongAccountJourney({
  apiClient,
  pending,
  onSwitchAccount,
  onDiscover,
}: Readonly<{
  apiClient: ApiClient;
  pending: boolean;
  onSwitchAccount: () => void;
  onDiscover: () => void;
}>) {
  return (
    <>
      <JourneyTitle>This invitation is for someone else</JourneyTitle>
      <AuthLensDescription>
        <SignedInEmail apiClient={apiClient} />, but this invitation was sent to
        a different address.
      </AuthLensDescription>
      <div className="mt-6 flex flex-col gap-2">
        <ProgressButton
          type="button"
          variant="primary"
          size="lg"
          className="w-full"
          pending={pending}
          pendingLabel="Opening sign-in…"
          onClick={onSwitchAccount}
        >
          Switch account
        </ProgressButton>
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={onDiscover}
        >
          Go to my workspaces
        </Button>
      </div>
    </>
  );
}

export function DeadEndJourney({
  state,
  onDiscover,
  onSignIn,
}: Readonly<{
  state: DeadEndState;
  onDiscover: () => void;
  /** Offered when the journey can't be read at all (a fresh browser). */
  onSignIn?: (() => void) | undefined;
}>) {
  const copy = DEAD_END_COPY[state];
  return (
    <>
      <StatusGlyph
        tone={state === 'expired' ? 'timeout' : 'canceled'}
        className="mb-4 size-6 text-subtle-foreground [&_svg]:size-6"
      />
      <JourneyTitle>{copy.title}</JourneyTitle>
      <AuthLensDescription>
        {copy.sentence} Ask an admin for a new invitation.
      </AuthLensDescription>
      {/* When the invitation can't be read, signing in is the way on. */}
      <div className="mt-6 flex flex-col gap-2">
        {onSignIn === undefined ? null : (
          <Button
            type="button"
            variant="primary"
            size="lg"
            className="w-full"
            onClick={onSignIn}
          >
            Sign in
          </Button>
        )}
        <Button
          type="button"
          variant={onSignIn === undefined ? 'primary' : 'ghost'}
          size={onSignIn === undefined ? 'lg' : 'default'}
          className={onSignIn === undefined ? 'w-full' : undefined}
          onClick={onDiscover}
        >
          Go to my workspaces
        </Button>
      </div>
    </>
  );
}
