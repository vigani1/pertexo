import { OrganizationSignInForm } from '@/features/federation/sign-in.public';
import {
  AuthLens,
  AuthLensTitle,
  AuthLensDescription,
} from '../components/stage/auth-lens';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ApiClient } from '@/lib/api/client';
import { authenticationCapabilitiesQueryOptions } from '../data/auth.queries';
import { EmailRequestLens } from '../components/inbox/email-request-lens';
import { InboxLens, RESEND_COOLDOWN_SECONDS } from '../components/inbox/lens';
import { SignInLens } from '../components/sign-in/lens';
import { AuthLensFooter } from '../components/stage/auth-lens';
import { LensLoading, LensUnavailable } from '../components/stage/lens-states';
import { resendFailure } from '../model/auth-failure';
import type { LoginNotice } from '../model/login-notice';
import { resendVerificationEmail } from '../data/native-auth.api';
import { useCountdown } from '@/lib/hooks/use-countdown';

type LoginView =
  | Readonly<{ kind: 'sign-in' }>
  | Readonly<{ kind: 'request-verification' }>
  | Readonly<{ kind: 'organization' }>
  | Readonly<{ kind: 'verify'; email: string }>;

type LoginPageProps = Readonly<{
  apiClient: ApiClient;
  navigateToProvider?: (authorizationUrl: string) => void;
  onAuthenticated?: () => void;
  notice?: LoginNotice | undefined;
  /** An allowlisted path to return to after sign-in. */
  returnTo?: string | undefined;
}>;

export function LoginPage({
  apiClient,
  navigateToProvider = (url) => {
    window.location.assign(url);
  },
  onAuthenticated = () => {
    window.location.assign('/workspaces');
  },
  notice,
  returnTo,
}: LoginPageProps) {
  const capabilities = useQuery(
    authenticationCapabilitiesQueryOptions(apiClient),
  );
  const [view, setView] = useState<LoginView>({ kind: 'sign-in' });
  const verificationCooldown = useCountdown();
  const backToSignIn = (label: string) => (
    <AuthLensFooter>
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto px-0"
        onClick={() => {
          setView({ kind: 'sign-in' });
        }}
      >
        {label}
      </Button>
    </AuthLensFooter>
  );

  if (capabilities.isPending)
    return (
      <LensLoading
        title="Sign in to continue"
        label="Checking how you can sign in…"
      />
    );
  if (
    capabilities.isError ||
    (!capabilities.data.password.enabled &&
      capabilities.data.socialProviders.length === 0)
  )
    return (
      <LensUnavailable
        id="login-unavailable"
        title="Sign in to continue"
        retrying={capabilities.isFetching}
        onRetry={() => void capabilities.refetch()}
      >
        Sign-in isn’t available right now. Try again in a moment.
      </LensUnavailable>
    );
  switch (view.kind) {
    case 'verify':
      return (
        <InboxLens
          title="Verify your email"
          cooldown={verificationCooldown}
          resend={(signal) =>
            resendVerificationEmail(
              apiClient,
              { email: view.email, returnTo },
              signal,
            )
          }
          footer={backToSignIn('Use another email')}
        >
          Open the verification link we sent to{' '}
          <strong className="font-semibold text-foreground">
            {view.email}
          </strong>
          , then sign in here.
        </InboxLens>
      );
    case 'request-verification':
      return (
        <EmailRequestLens
          id="verification-request"
          title="Get a new link"
          description="Enter your email and we’ll send a fresh verification link if the address still needs one."
          submitLabel="Send link"
          pendingLabel="Sending…"
          send={(email, signal) =>
            resendVerificationEmail(apiClient, { email, returnTo }, signal)
          }
          describeFailure={resendFailure}
          onSent={(email) => {
            verificationCooldown.startSeconds(RESEND_COOLDOWN_SECONDS);
            setView({ kind: 'verify', email });
          }}
          footer={backToSignIn('Back to sign in')}
        />
      );
    case 'organization':
      return (
        <AuthLens aria-labelledby="organization-sign-in-title">
          <AuthLensTitle id="organization-sign-in-title">
            Organization sign-in
          </AuthLensTitle>
          <AuthLensDescription>
            Continue with your organization’s identity provider.
          </AuthLensDescription>
          <OrganizationSignInForm
            apiClient={apiClient}
            returnTo={returnTo}
            navigateToProvider={navigateToProvider}
          />
          {backToSignIn('Back to sign in')}
        </AuthLens>
      );
    case 'sign-in':
      return (
        <SignInLens
          apiClient={apiClient}
          capabilities={capabilities.data}
          notice={notice}
          navigateToProvider={navigateToProvider}
          onAuthenticated={onAuthenticated}
          onUnverified={(email) => {
            setView({ kind: 'verify', email });
          }}
          onOrganizationSignIn={() => {
            setView({ kind: 'organization' });
          }}
          onRequestVerificationLink={() => {
            setView({ kind: 'request-verification' });
          }}
          returnTo={returnTo}
        />
      );
  }
}
