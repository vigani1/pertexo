import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ApiClient } from '@/lib/api/client';
import { authenticationCapabilitiesQueryOptions } from './auth.queries';
import { EmailRequestLens } from './components/inbox/email-request-lens';
import {
  InboxLens,
  RESEND_COOLDOWN_SECONDS,
} from './components/inbox/inbox-lens';
import { AuthLensFooter } from './components/stage/auth-lens';
import { AuthStage } from './components/stage/auth-stage';
import { LensLoading, LensUnavailable } from './components/stage/lens-states';
import { recoveryFailure } from './model/auth-failure';
import { requestPasswordReset } from './native-auth.api';
import { useCountdown } from './use-countdown';

const backToSignIn = (
  <AuthLensFooter>
    <Link to="/login">Back to sign in</Link>
  </AuthLensFooter>
);

export function PasswordRecoveryPage({
  apiClient,
}: Readonly<{ apiClient: ApiClient }>) {
  const capabilities = useQuery(
    authenticationCapabilitiesQueryOptions(apiClient),
  );
  const [sentTo, setSentTo] = useState<string>();
  const cooldown = useCountdown();

  return (
    <AuthStage>
      {capabilities.isPending ? (
        <LensLoading
          title="Reset your password"
          label="Checking password recovery…"
        />
      ) : capabilities.isError || !capabilities.data.password.enabled ? (
        <LensUnavailable
          id="recovery-unavailable"
          title="Reset your password"
          retrying={capabilities.isFetching}
          {...(capabilities.isError
            ? { onRetry: () => void capabilities.refetch() }
            : {})}
          footer={backToSignIn}
        >
          Password recovery is not available right now.
        </LensUnavailable>
      ) : sentTo === undefined ? (
        <EmailRequestLens
          id="recovery"
          title="Reset your password"
          description="Enter the email you sign in with. We’ll send a link to choose a new password."
          submitLabel="Send reset link"
          pendingLabel="Sending link…"
          send={(email, signal) =>
            requestPasswordReset(apiClient, email, signal)
          }
          describeFailure={recoveryFailure}
          onSent={(email) => {
            cooldown.startSeconds(RESEND_COOLDOWN_SECONDS);
            setSentTo(email);
          }}
          footer={backToSignIn}
        />
      ) : (
        <InboxLens
          title="Check your inbox"
          cooldown={cooldown}
          resend={(signal) => requestPasswordReset(apiClient, sentTo, signal)}
          resendLabel="Send again"
          footer={
            <AuthLensFooter className="flex flex-wrap justify-center gap-x-4">
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
                Use another email
              </Button>
              <Link to="/login">Back to sign in</Link>
            </AuthLensFooter>
          }
        >
          If an account exists for{' '}
          <strong className="font-semibold text-foreground">{sentTo}</strong>, a
          reset link is on its way. It works once and expires soon.
        </InboxLens>
      )}
    </AuthStage>
  );
}
