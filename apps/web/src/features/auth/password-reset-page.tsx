import { Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { buttonVariants } from '@/components/ui/button-variants';
import { StatusGlyph } from '@/components/ui/status';
import type { ApiClient } from '@/lib/api/client';
import { ResetPasswordLens } from './components/reset/reset-password-lens';
import {
  AuthLens,
  AuthLensDescription,
  AuthLensTitle,
} from './components/stage/auth-lens';
import { AuthStage } from './components/stage/auth-stage';
import { PasswordCapabilityGate } from './components/stage/lens-states';

function OutcomeLens({
  id,
  glyph,
  title,
  children,
  action,
}: Readonly<{
  id: string;
  glyph?: ReactNode;
  title: string;
  children: ReactNode;
  action: ReactNode;
}>) {
  return (
    <AuthLens aria-labelledby={id}>
      {glyph}
      <AuthLensTitle id={id}>{title}</AuthLensTitle>
      <AuthLensDescription>{children}</AuthLensDescription>
      <div className="mt-6">{action}</div>
    </AuthLens>
  );
}

const primaryLink = buttonVariants({
  variant: 'primary',
  size: 'lg',
  className: 'w-full',
});

export function PasswordResetPage({
  apiClient,
  token,
}: Readonly<{ apiClient: ApiClient; token?: string }>) {
  const [changed, setChanged] = useState(false);

  return (
    <AuthStage>
      {token === undefined ? (
        <OutcomeLens
          id="reset-incomplete"
          title="This link is incomplete"
          action={
            <Link to="/forgot-password" className={primaryLink}>
              Request a new one
            </Link>
          }
        >
          Part of the reset link is missing. Open the latest reset email again,
          or request a new link.
        </OutcomeLens>
      ) : (
        <PasswordCapabilityGate
          apiClient={apiClient}
          id="reset-unavailable"
          title="Choose a new password"
          loadingLabel="Checking password reset…"
          unavailable="Password reset is not available right now."
        >
          {(capabilities) =>
            changed ? (
              <OutcomeLens
                id="reset-done"
                glyph={
                  <StatusGlyph
                    tone="success"
                    className="mb-4 size-6 text-success motion-safe:animate-knot [&_svg]:size-6"
                  />
                }
                title="Password changed"
                action={
                  <Link to="/login" className={primaryLink}>
                    Sign in
                  </Link>
                }
              >
                We signed you out on every other device. Sign in with your new
                password.
              </OutcomeLens>
            ) : (
              <ResetPasswordLens
                apiClient={apiClient}
                token={token}
                minimumPasswordLength={capabilities.password.minimumLength}
                onReset={() => {
                  setChanged(true);
                }}
              />
            )
          }
        </PasswordCapabilityGate>
      )}
    </AuthStage>
  );
}
