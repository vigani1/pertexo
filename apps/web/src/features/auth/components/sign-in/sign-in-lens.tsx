import { useEffect, useEffectEvent } from 'react';
import type { AuthenticationCapabilitiesResponse } from '@pertexo/contracts/schemas/identity-workspace';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useFieldValues } from '@/components/ui/use-field-validation';
import type { ApiClient } from '@/lib/api/client';
import { emailProblem, requiredPasswordProblem } from '../../forms/field-rules';
import { AuthForm } from '../../forms/auth-form';
import { PasswordField } from '../../forms/password-field';
import type { LoginNotice } from '../../model/login-notice';
import { returnToSearch } from '../../model/return-path';
import { useSignIn } from '../../use-sign-in';
import { OrDivider, SocialProviderGrid } from '../social/social-provider-grid';
import {
  AuthLens,
  AuthLensDescription,
  AuthLensFooter,
  AuthLensTitle,
} from '../stage/auth-lens';
import { Notice } from '@/components/ui/notice';

const fieldRules = { email: emailProblem, password: requiredPasswordProblem };

/** Providers first, then email and password, in one glass lens. */
export function SignInLens({
  apiClient,
  capabilities,
  notice,
  navigateToProvider,
  onAuthenticated,
  onUnverified,
  onRequestVerificationLink,
  returnTo,
}: Readonly<{
  apiClient: ApiClient;
  capabilities: AuthenticationCapabilitiesResponse;
  notice: LoginNotice | undefined;
  navigateToProvider: (authorizationUrl: string) => void;
  onAuthenticated: () => void;
  onUnverified: (email: string) => void;
  onRequestVerificationLink: () => void;
  returnTo: string | undefined;
}>) {
  const signIn = useSignIn({
    apiClient,
    navigateToProvider,
    onAuthenticated,
    onUnverified,
    returnTo,
  });
  const fields = useFieldValues(
    fieldRules,
    { email: '', password: '' },
    signIn.clearFailure,
  );
  const providers = capabilities.socialProviders;
  const passwordEnabled = capabilities.password.enabled;
  const busy = signIn.pending || signIn.waitSeconds > 0;

  async function submit() {
    if (signIn.pending) return;
    const values = fields.validate();
    if (values === undefined) return;
    const signedIn = await signIn.withPassword(
      values.email.trim(),
      values.password,
    );
    if (signedIn) fields.reset({ email: values.email, password: '' });
  }

  // The fields were disabled while waiting, which drops focus; a refusal
  // puts people back in the password, where they can fix it.
  const failed = signIn.failure !== undefined && !signIn.pending;
  const focusPassword = useEffectEvent(() => {
    fields.focus('password');
  });
  useEffect(() => {
    if (failed) focusPassword();
  }, [failed]);

  return (
    <AuthLens pending={signIn.pending} aria-labelledby="login-title">
      <AuthLensTitle id="login-title">Sign in to continue</AuthLensTitle>
      <AuthLensDescription>
        Your workflows are where you left them.
      </AuthLensDescription>
      {notice === undefined ? null : (
        <Notice
          tone={notice.tone}
          glyph={notice.glyph}
          className="mt-5"
          action={
            notice.offersNewVerificationLink === true && passwordEnabled ? (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto px-0"
                onClick={onRequestVerificationLink}
              >
                Send a new link
              </Button>
            ) : undefined
          }
        >
          {notice.text}
        </Notice>
      )}
      {providers.length === 0 ? null : (
        <div className="mt-6">
          <SocialProviderGrid
            label="Sign in with a provider"
            providers={providers}
            disabled={busy}
            onSelect={(provider) => void signIn.withProvider(provider)}
          />
        </div>
      )}
      {passwordEnabled ? (
        <>
          {providers.length === 0 ? (
            <div className="mt-6" />
          ) : (
            <OrDivider>or with email</OrDivider>
          )}
          <AuthForm
            failure={signIn.failure}
            failureAction={
              signIn.mismatch ? (
                <Link to="/forgot-password" className="inline-link">
                  Reset your password
                </Link>
              ) : undefined
            }
            pending={signIn.pending}
            pendingLabel="Signing in…"
            submitLabel="Sign in"
            waitSeconds={signIn.waitSeconds}
            onSubmit={() => void submit()}
          >
            <LabelledField
              id="login-email"
              label="Email"
              {...fields.field('email')}
            >
              {(control) => (
                <Input
                  {...control}
                  type="email"
                  autoComplete="email"
                  disabled={signIn.pending}
                  {...fields.control('email')}
                />
              )}
            </LabelledField>
            <PasswordField
              id="login-password"
              label="Password"
              autoComplete="current-password"
              disabled={signIn.pending}
              {...fields.field('password')}
              labelAction={
                <Link
                  to="/forgot-password"
                  aria-label="Forgot your password?"
                  className="inline-link"
                >
                  Forgot?
                </Link>
              }
              {...fields.control('password')}
            />
          </AuthForm>
          <AuthLensFooter>
            New to Pertexo?{' '}
            <Link to="/sign-up" search={returnToSearch(returnTo)}>
              Create an account
            </Link>
          </AuthLensFooter>
        </>
      ) : signIn.failure === undefined ? null : (
        <Notice tone="destructive" className="mt-4">
          {signIn.failure}
        </Notice>
      )}
      {capabilities.legacyMigrationAvailable ? (
        <AuthLensFooter className="mt-2">
          Used Pertexo before the new sign-in?{' '}
          <Link to="/account/migrate">Move your account</Link>
        </AuthLensFooter>
      ) : null}
    </AuthLens>
  );
}
