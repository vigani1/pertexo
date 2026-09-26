import { Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { buttonVariants } from '@/components/ui/button-variants';
import { StatusGlyph } from '@/components/ui/status';
import type { ApiClient } from '@/lib/api/client';
import { ResetPasswordLens } from './components/reset/reset-password-lens';
import {
  AuthLens,
  AuthLensDescription,
  AuthLensFooter,
  AuthLensTitle,
} from './components/stage/auth-lens';
import { PasswordCapabilityGate } from './components/stage/lens-states';

function OutcomeLens({
  id,
  glyph,
  title,
  children,
  action,
  footer,
}: Readonly<{
  id: string;
  glyph?: ReactNode;
  title: string;
  children: ReactNode;
  action: ReactNode;
  footer?: ReactNode;
}>) {
  return (
    <AuthLens aria-labelledby={id}>
      {glyph}
      <AuthLensTitle id={id}>{title}</AuthLensTitle>
      <AuthLensDescription>{children}</AuthLensDescription>
      <div className="mt-6">{action}</div>
      {footer}
    </AuthLens>
  );
}

const backToSignIn = (
  <AuthLensFooter>
    <Link to="/login">Back to sign in</Link>
  </AuthLensFooter>
);

const primaryLink = buttonVariants({
  variant: 'primary',
  className: 'w-full',
});

export function PasswordResetPage({
  apiClient,
  token,
}: Readonly<{ apiClient: ApiClient; token?: string }>) {
  const [changed, setChanged] = useState(false);
  const [linkInvalid, setLinkInvalid] = useState(false);

  return (
    <>
      {token === undefined ? (
        <OutcomeLens
          id="reset-incomplete"
          title="This link is incomplete"
          action={
            <Link to="/forgot-password" className={primaryLink}>
              Request a new one
            </Link>
          }
          footer={backToSignIn}
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
            linkInvalid ? (
              <OutcomeLens
                id="reset-expired"
                title="This reset link has expired"
                action={
                  <Link to="/forgot-password" className={primaryLink}>
                    Request a new link
                  </Link>
                }
                footer={backToSignIn}
              >
                A reset link works once and only for a while. Request a new one
                and open the latest email.
              </OutcomeLens>
            ) : changed ? (
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
                onLinkInvalid={() => {
                  setLinkInvalid(true);
                }}
              />
            )
          }
        </PasswordCapabilityGate>
      )}
    </>
  );
}
