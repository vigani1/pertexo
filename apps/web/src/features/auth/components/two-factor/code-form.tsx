import { useEffect, useEffectEvent, type ReactNode } from 'react';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { AuthForm } from '../../forms/submission';
import type { useTwoFactorVerification } from './use-verify';

export function TwoFactorCodeForm({
  verification,
  secondaryAction,
}: Readonly<{
  verification: ReturnType<typeof useTwoFactorVerification>;
  secondaryAction?: ReactNode;
}>) {
  const { pending, method } = verification;
  const focusCode = useEffectEvent(() => {
    verification.fields.focus('code');
  });
  useEffect(() => {
    if (!pending) focusCode();
  }, [pending, method]);
  return (
    <AuthForm
      secondaryAction={secondaryAction}
      failure={verification.failure}
      submission={{
        pending: verification.pending,
        pendingLabel: 'Checking…',
        submitLabel: 'Verify code',
        waitSeconds: verification.waitSeconds,
        onSubmit: () => void verification.submit(),
      }}
    >
      <LabelledField
        id="two-factor-code"
        label={
          verification.method === 'totp'
            ? 'Authenticator code'
            : 'Recovery code'
        }
        {...verification.fields.field('code')}
      >
        {(control) => (
          <Input
            {...control}
            {...verification.fields.control('code')}
            autoComplete="one-time-code"
            inputMode={verification.method === 'totp' ? 'numeric' : 'text'}
            maxLength={verification.method === 'totp' ? 32 : 128}
            disabled={verification.pending}
            autoCapitalize="none"
            spellCheck={false}
          />
        )}
      </LabelledField>
    </AuthForm>
  );
}
