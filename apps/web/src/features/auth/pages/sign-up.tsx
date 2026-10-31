import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import type { ApiClient } from '@/lib/api/client';
import { InboxLens, RESEND_COOLDOWN_SECONDS } from '../components/inbox/lens';
import { SignUpLens } from '../components/sign-up/lens';
import {
  AuthLens,
  AuthLensDescription,
  AuthLensFooter,
  AuthLensTitle,
} from '../components/stage/auth-lens';
import { isInvitationReturn } from '../model/return-path';
import { PasswordCapabilityGate } from '../components/stage/lens-states';
import { resendVerificationEmail } from '../data/native-auth.api';
import { useCountdown } from '@/lib/hooks/use-countdown';

/** Said on its own page, because a link can still bring someone here. */
function SignUpClosedLens() {
  return (
    <AuthLens aria-labelledby="sign-up-closed-title">
      <AuthLensTitle id="sign-up-closed-title">
        Accounts are by invitation
      </AuthLensTitle>
      <AuthLensDescription>
        Ask someone in your workspace for an invitation, then open the link they
        send you.
      </AuthLensDescription>
      <AuthLensFooter>
        Have an account? <Link to="/login">Sign in</Link>
      </AuthLensFooter>
    </AuthLens>
  );
}

export function SignUpPage({
  apiClient,
  returnTo,
}: Readonly<{
  apiClient: ApiClient;
  /** Kept through email verification so sign-in comes back here. */
  returnTo?: string | undefined;
}>) {
  const [sentTo, setSentTo] = useState<string>();
  const cooldown = useCountdown();

  return (
    <>
      <PasswordCapabilityGate
        apiClient={apiClient}
        id="sign-up-unavailable"
        title="Create your account"
        loadingLabel="Checking how you can create an account…"
        unavailable="Password sign-up is not available right now."
      >
        {(capabilities) => {
          if (
            capabilities.signUp === 'invitation' &&
            !isInvitationReturn(returnTo)
          )
            return <SignUpClosedLens />;
          return sentTo === undefined ? (
            <SignUpLens
              apiClient={apiClient}
              minimumPasswordLength={capabilities.password.minimumLength}
              returnTo={returnTo}
              onCreated={(email) => {
                cooldown.startSeconds(RESEND_COOLDOWN_SECONDS);
                setSentTo(email);
              }}
            />
          ) : (
            <InboxLens
              title="Check your inbox"
              cooldown={cooldown}
              resend={(signal) =>
                resendVerificationEmail(
                  apiClient,
                  { email: sentTo, returnTo },
                  signal,
                )
              }
              footer={
                <AuthLensFooter>
                  Wrong address?{' '}
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto px-0"
                    onClick={() => {
                      cooldown.clear();
                      setSentTo(undefined);
                    }}
                  >
                    Start over
                  </Button>
                </AuthLensFooter>
              }
            >
              We sent a verification link to{' '}
              <strong className="font-semibold text-foreground">
                {sentTo}
              </strong>
              . Open it to finish, then sign in.
            </InboxLens>
          );
        }}
      </PasswordCapabilityGate>
    </>
  );
}
