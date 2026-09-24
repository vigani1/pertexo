import type { AuthenticationCapabilitiesResponse } from '@pertexo/contracts/schemas/identity-workspace';
import { Link } from '@tanstack/react-router';
import type { SyntheticEvent } from 'react';
import { Button } from '@/components/ui/button';
import type { ApiClient } from '@/lib/api/client';
import { emailProblem, requiredPasswordProblem } from '../../forms/field-rules';
import { PasswordField } from '../../forms/password-field';
import { ProgressButton } from '../../forms/progress-button';
import { TextField } from '@/components/patterns/text-field';
import { useValidatedFields } from '../../forms/use-validated-fields';
import type { LoginNotice } from '../../model/login-notice';
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
}: Readonly<{
  apiClient: ApiClient;
  capabilities: AuthenticationCapabilitiesResponse;
  notice: LoginNotice | undefined;
  navigateToProvider: (authorizationUrl: string) => void;
  onAuthenticated: () => void;
  onUnverified: (email: string) => void;
  onRequestVerificationLink: () => void;
}>) {
  const signIn = useSignIn({
    apiClient,
    navigateToProvider,
    onAuthenticated,
    onUnverified,
  });
  const fields = useValidatedFields(fieldRules, { email: '', password: '' });
  const providers = capabilities.socialProviders;
  const passwordEnabled = capabilities.password.enabled;
  const busy = signIn.pending || signIn.waitSeconds > 0;

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (signIn.pending) return;
    const values = fields.validateAll();
    if (values === undefined) return;
    const signedIn = await signIn.withPassword(
      values.email.trim(),
      values.password,
    );
    if (signedIn) fields.reset({ email: values.email, password: '' });
  }

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
          <form
            noValidate
            className="flex flex-col gap-4"
            onSubmit={(event) => void submit(event)}
          >
            <TextField
              id="login-email"
              label="Email"
              type="email"
              autoComplete="email"
              disabled={signIn.pending}
              error={fields.errors.email}
              state={fields.threadState('email')}
              {...fields.inputProps('email')}
            />
            <PasswordField
              id="login-password"
              label="Password"
              autoComplete="current-password"
              disabled={signIn.pending}
              error={fields.errors.password}
              state={fields.threadState('password')}
              labelAction={
                <Link
                  to="/forgot-password"
                  aria-label="Forgot your password?"
                  className="text-[0.78rem] font-medium text-accent-foreground underline-offset-4 hover:underline"
                >
                  Forgot?
                </Link>
              }
              {...fields.inputProps('password')}
            />
            {signIn.failure === undefined ? null : (
              <Notice tone="destructive">{signIn.failure}</Notice>
            )}
            <ProgressButton
              type="submit"
              variant="primary"
              size="lg"
              className="mt-1 w-full"
              pending={signIn.pending}
              pendingLabel="Signing in…"
              waitSeconds={signIn.waitSeconds}
            >
              Sign in
            </ProgressButton>
          </form>
          <AuthLensFooter>
            New to Pertexo? <Link to="/sign-up">Create an account</Link>
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
