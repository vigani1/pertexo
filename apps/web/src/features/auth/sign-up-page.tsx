import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { AuroraLoadingPanel } from '@/components/patterns/aurora-loading-panel';
import {
  GlassSection,
  GlassSectionContent,
  GlassSectionDescription,
  GlassSectionHeader,
  GlassSectionTitle,
} from '@/components/patterns/glass-section';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { ApiClient } from '@/lib/api/client';
import { authenticationCapabilitiesQueryOptions } from './auth.queries';
import { AuthenticationShell } from './authentication-shell';
import {
  NativeAuthenticationError,
  resendVerificationEmail,
  signUpWithEmail,
} from './native-auth.api';

export function SignUpPage({ apiClient }: Readonly<{ apiClient: ApiClient }>) {
  const capabilities = useQuery(
    authenticationCapabilitiesQueryOptions(apiClient),
  );
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [resendEmail, setResendEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [submittedEmail, setSubmittedEmail] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [resendMessage, setResendMessage] = useState<{
    kind: 'validation' | 'request-error' | 'status';
    text: string;
  }>();
  const firstField = useRef<HTMLInputElement>(null);
  const resendField = useRef<HTMLInputElement>(null);
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
    if (
      displayName.trim().length === 0 ||
      !email.includes('@') ||
      password.length < 12
    ) {
      setMessage(
        'Enter your name, a valid email, and a password of at least 12 characters.',
      );
      firstField.current?.focus();
      return;
    }
    const controller = new AbortController();
    activeRequest.current = controller;
    setPending(true);
    setMessage(undefined);
    try {
      await signUpWithEmail(
        apiClient,
        {
          displayName: displayName.trim(),
          email: email.trim(),
          password,
        },
        controller.signal,
      );
      if (activeRequest.current !== controller || controller.signal.aborted)
        return;
      setPassword('');
      setSubmittedEmail(email.trim());
    } catch (error) {
      if (activeRequest.current === controller && !controller.signal.aborted)
        setMessage(signUpError(error));
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = undefined;
        setPending(false);
      }
    }
  }

  async function resend(address: string) {
    if (pending) return;
    if (!address.includes('@')) {
      setResendMessage({
        kind: 'validation',
        text: 'Enter the email address awaiting verification.',
      });
      resendField.current?.focus();
      return;
    }
    const controller = new AbortController();
    activeRequest.current = controller;
    setPending(true);
    setResendMessage(undefined);
    try {
      await resendVerificationEmail(
        apiClient,
        address.trim(),
        controller.signal,
      );
      if (activeRequest.current !== controller || controller.signal.aborted)
        return;
      setSubmittedEmail(address.trim());
      setResendMessage({
        kind: 'status',
        text: 'If this address needs verification, a new link has been requested.',
      });
    } catch (error) {
      if (activeRequest.current === controller && !controller.signal.aborted)
        setResendMessage({ kind: 'request-error', text: signUpError(error) });
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = undefined;
        setPending(false);
      }
    }
  }

  return (
    <AuthenticationShell>
      <AuroraLoadingPanel active={pending}>
        <GlassSection aria-labelledby="sign-up-title" aria-busy={pending}>
          <GlassSectionHeader>
            <GlassSectionTitle id="sign-up-title">
              Create your account
            </GlassSectionTitle>
            <GlassSectionDescription>
              Verify your email before entering a workspace. Creating an account
              does not grant workspace access.
            </GlassSectionDescription>
          </GlassSectionHeader>
          <GlassSectionContent>
            {capabilities.isPending ? (
              <p role="status">Checking available sign-up methods…</p>
            ) : capabilities.isError || !capabilities.data.password.enabled ? (
              <div className="space-y-3" role="alert">
                <p>Password sign-up is not available right now.</p>
                {capabilities.isError ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void capabilities.refetch()}
                  >
                    Try again
                  </Button>
                ) : null}
              </div>
            ) : submittedEmail === undefined ? (
              <div className="space-y-6">
                <form
                  className="flex flex-col gap-5"
                  onSubmit={(event) => void submit(event)}
                >
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="sign-up-name">
                        Display name
                      </FieldLabel>
                      <Input
                        ref={firstField}
                        id="sign-up-name"
                        name="name"
                        autoComplete="name"
                        required
                        maxLength={256}
                        value={displayName}
                        disabled={pending}
                        onChange={(event) => {
                          setDisplayName(event.target.value);
                        }}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="sign-up-email">Email</FieldLabel>
                      <Input
                        id="sign-up-email"
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
                      <FieldLabel htmlFor="sign-up-password">
                        Password
                      </FieldLabel>
                      <Input
                        id="sign-up-password"
                        name="password"
                        type="password"
                        autoComplete="new-password"
                        required
                        minLength={12}
                        maxLength={128}
                        value={password}
                        disabled={pending}
                        aria-describedby="sign-up-password-help"
                        onChange={(event) => {
                          setPassword(event.target.value);
                        }}
                      />
                      <FieldDescription id="sign-up-password-help">
                        Use at least 12 characters. Password managers and paste
                        are supported.
                      </FieldDescription>
                    </Field>
                  </FieldGroup>
                  {message === undefined ? null : (
                    <FieldError>{message}</FieldError>
                  )}
                  <Button type="submit" size="lg" disabled={pending}>
                    {pending ? 'Creating account…' : 'Create account'}
                  </Button>
                </form>
                <form
                  className="grid gap-3 border-t border-border pt-5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void resend(resendEmail);
                  }}
                >
                  <Field>
                    <FieldLabel htmlFor="resend-verification-email">
                      Need another verification link?
                    </FieldLabel>
                    <Input
                      ref={resendField}
                      id="resend-verification-email"
                      name="resendEmail"
                      type="email"
                      autoComplete="email"
                      value={resendEmail}
                      disabled={pending}
                      aria-invalid={
                        resendMessage?.kind === 'validation' ? true : undefined
                      }
                      aria-describedby={
                        resendMessage === undefined
                          ? undefined
                          : 'resend-verification-message'
                      }
                      onChange={(event) => {
                        setResendEmail(event.target.value);
                        setResendMessage(undefined);
                      }}
                    />
                  </Field>
                  {resendMessage === undefined ? null : (
                    <p
                      id="resend-verification-message"
                      role={
                        resendMessage.kind === 'status' ? 'status' : 'alert'
                      }
                      className={
                        resendMessage.kind === 'status'
                          ? 'text-sm text-muted-foreground'
                          : 'text-sm text-destructive'
                      }
                    >
                      {resendMessage.text}
                    </p>
                  )}
                  <Button
                    type="submit"
                    variant="outline"
                    className="w-fit"
                    disabled={pending}
                  >
                    Resend verification email
                  </Button>
                </form>
              </div>
            ) : (
              <div className="flex flex-col gap-5">
                <p role="status" className="leading-relaxed">
                  Check <strong>{submittedEmail}</strong> for a verification
                  link if this address needs verification. After verification,
                  return to sign in.
                </p>
                {resendMessage === undefined ? null : (
                  <p role="status" className="text-sm text-muted-foreground">
                    {resendMessage.text}
                  </p>
                )}
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => void resend(submittedEmail)}
                >
                  {pending ? 'Requesting…' : 'Resend verification email'}
                </Button>
              </div>
            )}
            <p className="mt-5 text-sm">
              <a href="/login" className="text-primary hover:underline">
                Return to sign in
              </a>
            </p>
          </GlassSectionContent>
        </GlassSection>
      </AuroraLoadingPanel>
    </AuthenticationShell>
  );
}

function signUpError(error: unknown): string {
  if (error instanceof NativeAuthenticationError) {
    if (error.status === 422 || error.status === 400)
      return 'Check the account details and try again.';
    if (error.status === 429)
      return 'Too many requests. Wait a moment before trying again.';
    if (
      error.kind === 'network' ||
      error.kind === 'timeout' ||
      (error.status ?? 0) >= 500
    )
      return 'The response was lost or delayed. Check your email, or request another verification link before creating another account.';
  }
  return 'Account creation could not be confirmed. Check your email or try again.';
}
