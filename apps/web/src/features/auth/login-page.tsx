import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { AuroraLoadingPanel } from '@/components/patterns/aurora-loading-panel';
import { LoadingOrb } from '@/components/patterns/loading-orb';
import {
  GlassSection,
  GlassSectionContent,
  GlassSectionDescription,
  GlassSectionHeader,
  GlassSectionTitle,
} from '@/components/patterns/glass-section';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { ApiClient } from '@/lib/api/client';
import { authenticationCapabilitiesQueryOptions } from './auth.queries';
import { AuthenticationShell } from './authentication-shell';
import { SocialProviderButton } from './components/social-provider-button';
import {
  NativeAuthenticationError,
  signInWithEmail,
  startSocialAuthentication,
} from './native-auth.api';

type LoginPageProps = Readonly<{
  apiClient: ApiClient;
  navigateToProvider?: (authorizationUrl: string) => void;
  onAuthenticated?: () => void;
  notice?: string;
}>;

export function LoginPage({
  apiClient,
  navigateToProvider = (url) => {
    window.location.assign(url);
  },
  onAuthenticated = () => {
    window.location.assign('/workspaces');
  },
  notice,
}: LoginPageProps) {
  const capabilities = useQuery(
    authenticationCapabilitiesQueryOptions(apiClient),
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const emailRef = useRef<HTMLInputElement>(null);
  const activeRequest = useRef<AbortController | undefined>(undefined);

  useEffect(
    () => () => {
      activeRequest.current?.abort();
      activeRequest.current = undefined;
    },
    [],
  );

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (!email.includes('@')) {
      setMessage('Enter the email address for your Pertexo account.');
      emailRef.current?.focus();
      return;
    }
    const controller = new AbortController();
    activeRequest.current = controller;
    setPending(true);
    setMessage(undefined);
    try {
      await signInWithEmail(
        apiClient,
        { email: email.trim(), password },
        controller.signal,
      );
      if (activeRequest.current !== controller || controller.signal.aborted)
        return;
      setPassword('');
      onAuthenticated();
    } catch (error) {
      if (activeRequest.current === controller && !controller.signal.aborted)
        setMessage(loginError(error));
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = undefined;
        setPending(false);
      }
    }
  }

  async function startProvider(
    provider: 'google' | 'microsoft' | 'github' | 'apple',
  ) {
    if (pending) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setPending(true);
    setMessage(undefined);
    try {
      const url = await startSocialAuthentication(
        apiClient,
        provider,
        controller.signal,
      );
      if (activeRequest.current !== controller || controller.signal.aborted)
        return;
      navigateToProvider(url);
    } catch (error) {
      if (activeRequest.current === controller && !controller.signal.aborted) {
        setMessage(loginError(error));
        setPending(false);
      }
    }
  }

  const configured = capabilities.data;
  const unavailable =
    capabilities.isError ||
    (configured !== undefined &&
      !configured.password.enabled &&
      configured.socialProviders.length === 0);

  return (
    <AuthenticationShell>
      <AuroraLoadingPanel active={pending || capabilities.isPending}>
        <GlassSection
          aria-labelledby="login-title"
          aria-busy={pending || capabilities.isPending}
        >
          <GlassSectionHeader>
            <GlassSectionTitle id="login-title">
              Sign in to continue
            </GlassSectionTitle>
            <GlassSectionDescription>
              Use your verified email or one of the configured identity
              providers.
            </GlassSectionDescription>
          </GlassSectionHeader>
          <GlassSectionContent className="flex flex-col gap-5">
            {capabilities.isPending ? (
              <p role="status" className="text-sm text-muted-foreground">
                Checking available sign-in methods…
              </p>
            ) : unavailable ? (
              <div
                role="alert"
                className="rounded-lg border border-destructive/35 bg-destructive/10 px-4 py-3 text-sm text-destructive"
              >
                Authentication is not available right now. Ask the Pertexo
                operator to check the identity configuration.
              </div>
            ) : null}
            {message === undefined ? null : (
              <p
                role="alert"
                className="rounded-lg border border-destructive/35 bg-destructive/10 px-4 py-3 text-sm text-destructive"
              >
                {message}
              </p>
            )}
            {message !== undefined || notice === undefined ? null : (
              <p
                role="status"
                className="rounded-lg border border-primary/25 bg-primary/10 px-4 py-3 text-sm text-accent-foreground"
              >
                {notice}
              </p>
            )}
            {configured?.password.enabled === true ? (
              <form
                className="flex flex-col gap-5"
                onSubmit={(event) => void submit(event)}
              >
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="login-email">Email</FieldLabel>
                    <Input
                      ref={emailRef}
                      id="login-email"
                      name="email"
                      type="email"
                      autoComplete="email"
                      required
                      value={email}
                      disabled={pending}
                      onChange={(event) => {
                        setEmail(event.target.value);
                      }}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="login-password">Password</FieldLabel>
                    <Input
                      id="login-password"
                      name="password"
                      type="password"
                      autoComplete="current-password"
                      required
                      minLength={configured.password.minimumLength}
                      maxLength={128}
                      value={password}
                      disabled={pending}
                      onChange={(event) => {
                        setPassword(event.target.value);
                      }}
                    />
                  </Field>
                </FieldGroup>
                <Button
                  type="submit"
                  size="lg"
                  className="w-full disabled:opacity-75"
                  disabled={pending}
                >
                  {pending ? <LoadingOrb /> : null}
                  {pending ? 'Signing in…' : 'Sign in'}
                </Button>
                <div className="flex items-center justify-between gap-4 text-sm">
                  <a
                    href="/forgot-password"
                    className="text-primary hover:underline"
                  >
                    Forgot password?
                  </a>
                  <a href="/sign-up" className="text-primary hover:underline">
                    Create account
                  </a>
                </div>
                {configured.legacyMigrationAvailable ? (
                  <Link
                    to="/account/migrate"
                    className="text-sm font-medium text-primary hover:underline"
                  >
                    Recover an existing Pertexo account
                  </Link>
                ) : null}
              </form>
            ) : null}
            {configured !== undefined &&
            configured.socialProviders.length > 0 ? (
              <div
                className="grid gap-2 border-t pt-5 min-[30rem]:grid-cols-2"
                aria-label="Social sign-in methods"
              >
                {configured.socialProviders.map((provider) => (
                  <SocialProviderButton
                    key={provider}
                    provider={provider}
                    type="button"
                    disabled={pending}
                    onClick={() => void startProvider(provider)}
                  />
                ))}
              </div>
            ) : null}
            <p className="text-center text-xs leading-relaxed text-muted-foreground">
              Sessions use secure browser cookies and workspace access remains
              server-authorized.
            </p>
          </GlassSectionContent>
        </GlassSection>
      </AuroraLoadingPanel>
    </AuthenticationShell>
  );
}

function loginError(error: unknown): string {
  if (error instanceof NativeAuthenticationError) {
    if (error.code === 'auth.email_not_verified')
      return 'Verify your email before signing in. You can resend the verification message from account creation.';
    if (error.status === 401 || error.status === 400)
      return 'The email or password is incorrect.';
    if (error.status === 429)
      return 'Too many sign-in attempts. Wait a moment and try again.';
    if (error.status === 403)
      return 'This sign-in request was rejected. Reload the page and try again.';
    if (error.status === 503 && error.kind === 'problem') return error.message;
    if (error.kind === 'network' || error.kind === 'timeout')
      return 'The sign-in response was lost. Check whether this browser is signed in before trying again.';
  }
  return 'Sign in could not be confirmed. Try again.';
}
