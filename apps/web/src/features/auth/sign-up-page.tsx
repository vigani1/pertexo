import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ApiClient } from '@/lib/api/client';
import { authenticationCapabilitiesQueryOptions } from './auth.queries';
import {
  InboxLens,
  RESEND_COOLDOWN_SECONDS,
} from './components/inbox/inbox-lens';
import { SignUpLens } from './components/sign-up/sign-up-lens';
import { AuthLensFooter } from './components/stage/auth-lens';
import { AuthStage } from './components/stage/auth-stage';
import { LensLoading, LensUnavailable } from './components/stage/lens-states';
import { resendVerificationEmail } from './native-auth.api';
import { useCountdown } from './use-countdown';

export function SignUpPage({ apiClient }: Readonly<{ apiClient: ApiClient }>) {
  const capabilities = useQuery(
    authenticationCapabilitiesQueryOptions(apiClient),
  );
  const [sentTo, setSentTo] = useState<string>();
  const cooldown = useCountdown();

  return (
    <AuthStage>
      {capabilities.isPending ? (
        <LensLoading
          title="Create your account"
          label="Checking how you can create an account…"
        />
      ) : capabilities.isError || !capabilities.data.password.enabled ? (
        <LensUnavailable
          id="sign-up-unavailable"
          title="Create your account"
          retrying={capabilities.isFetching}
          {...(capabilities.isError
            ? { onRetry: () => void capabilities.refetch() }
            : {})}
          footer={
            <AuthLensFooter>
              <Link to="/login">Back to sign in</Link>
            </AuthLensFooter>
          }
        >
          Password sign-up is not available right now.
        </LensUnavailable>
      ) : sentTo === undefined ? (
        <SignUpLens
          apiClient={apiClient}
          minimumPasswordLength={capabilities.data.password.minimumLength}
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
            resendVerificationEmail(apiClient, sentTo, signal)
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
          <strong className="font-semibold text-foreground">{sentTo}</strong>.
          Open it to finish, then sign in.
        </InboxLens>
      )}
    </AuthStage>
  );
}
