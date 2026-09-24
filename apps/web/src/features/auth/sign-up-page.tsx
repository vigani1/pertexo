import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ApiClient } from '@/lib/api/client';
import {
  InboxLens,
  RESEND_COOLDOWN_SECONDS,
} from './components/inbox/inbox-lens';
import { SignUpLens } from './components/sign-up/sign-up-lens';
import { AuthLensFooter } from './components/stage/auth-lens';
import { AuthStage } from './components/stage/auth-stage';
import { PasswordCapabilityGate } from './components/stage/lens-states';
import { resendVerificationEmail } from './native-auth.api';
import { useCountdown } from '@/lib/use-countdown';

export function SignUpPage({ apiClient }: Readonly<{ apiClient: ApiClient }>) {
  const [sentTo, setSentTo] = useState<string>();
  const cooldown = useCountdown();

  return (
    <AuthStage>
      <PasswordCapabilityGate
        apiClient={apiClient}
        id="sign-up-unavailable"
        title="Create your account"
        loadingLabel="Checking how you can create an account…"
        unavailable="Password sign-up is not available right now."
      >
        {(capabilities) =>
          sentTo === undefined ? (
            <SignUpLens
              apiClient={apiClient}
              minimumPasswordLength={capabilities.password.minimumLength}
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
              <strong className="font-semibold text-foreground">
                {sentTo}
              </strong>
              . Open it to finish, then sign in.
            </InboxLens>
          )
        }
      </PasswordCapabilityGate>
    </AuthStage>
  );
}
