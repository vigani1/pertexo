import { useState } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import {
  AuthLens,
  AuthLensTitle,
  AuthLensDescription,
  AuthLensFooter,
} from '../stage/auth-lens';
import { TwoFactorCodeForm } from './code-form';
import { useTwoFactorVerification } from './use-verify';

export function TwoFactorSignInLens({
  apiClient,
  onAuthenticated,
  onBack,
}: Readonly<{
  apiClient: ApiClient;
  onAuthenticated: () => void;
  onBack: () => void;
}>) {
  const [method, setMethod] = useState<'totp' | 'recovery'>('totp');
  const verification = useTwoFactorVerification({
    apiClient,
    method,
    purpose: 'sign-in',
    onVerified: onAuthenticated,
  });
  return (
    <AuthLens aria-labelledby="two-factor-title">
      <AuthLensTitle id="two-factor-title">
        {method === 'totp' ? 'Check your authenticator' : 'Use a recovery code'}
      </AuthLensTitle>
      <AuthLensDescription>
        {method === 'totp'
          ? 'Enter the 6-digit code from your authenticator app.'
          : 'Each recovery code can be used once.'}
      </AuthLensDescription>
      <div className="mt-6">
        <TwoFactorCodeForm verification={verification} />
      </div>
      <AuthLensFooter>
        <Button
          type="button"
          variant="link"
          size="sm"
          disabled={verification.pending}
          onClick={() => {
            verification.reset();
            setMethod(method === 'totp' ? 'recovery' : 'totp');
          }}
        >
          {method === 'totp'
            ? 'Use a recovery code instead'
            : 'Use an authenticator code instead'}
        </Button>
      </AuthLensFooter>
      <AuthLensFooter>
        <Button
          type="button"
          variant="link"
          size="sm"
          disabled={verification.pending}
          onClick={onBack}
        >
          Back to sign in
        </Button>
      </AuthLensFooter>
    </AuthLens>
  );
}
