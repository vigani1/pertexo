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
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { ApiClient } from '@/lib/api/client';
import { authenticationCapabilitiesQueryOptions } from './auth.queries';
import { AuthenticationShell } from './authentication-shell';
import { NativeAuthenticationError, resetPassword } from './native-auth.api';

export function PasswordResetPage({
  apiClient,
  token,
}: Readonly<{ apiClient: ApiClient; token?: string }>) {
  const capabilities = useQuery(
    authenticationCapabilitiesQueryOptions(apiClient),
  );
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [complete, setComplete] = useState(false);
  const [fieldError, setFieldError] = useState<string>();
  const [requestError, setRequestError] = useState<string>();
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(
    () => () => {
      request.current?.abort();
      request.current = undefined;
    },
    [],
  );

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      pending ||
      token === undefined ||
      capabilities.data?.password.enabled !== true
    )
      return;
    if (password.length < 12) {
      setFieldError('Use at least 12 characters.');
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setFieldError(undefined);
    setRequestError(undefined);
    try {
      await resetPassword(apiClient, { token, password }, controller.signal);
      if (request.current !== controller || controller.signal.aborted) return;
      setPassword('');
      setComplete(true);
    } catch (error) {
      if (request.current === controller && !controller.signal.aborted)
        setRequestError(resetFailureMessage(error));
    } finally {
      if (request.current === controller) {
        request.current = undefined;
        setPending(false);
      }
    }
  }

  return (
    <AuthenticationShell>
      <AuroraLoadingPanel active={pending}>
        <GlassSection aria-labelledby="reset-title" aria-busy={pending}>
          <GlassSectionHeader>
            <GlassSectionTitle id="reset-title">
              Choose a new password
            </GlassSectionTitle>
            <GlassSectionDescription>
              Resetting your password signs out existing sessions. Sign in again
              afterward.
            </GlassSectionDescription>
          </GlassSectionHeader>
          <GlassSectionContent>
            {token === undefined ? (
              <div className="flex flex-col gap-4">
                <p role="alert" className="text-destructive">
                  This reset link is incomplete.
                </p>
                <a
                  href="/forgot-password"
                  className="text-primary hover:underline"
                >
                  Request a new reset link
                </a>
              </div>
            ) : capabilities.isPending ? (
              <p role="status">Checking password reset availability…</p>
            ) : capabilities.isError || !capabilities.data.password.enabled ? (
              <div className="space-y-3" role="alert">
                <p>Password reset is not available right now.</p>
                {capabilities.isError ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void capabilities.refetch()}
                  >
                    Try again
                  </Button>
                ) : null}
                <a
                  href="/login"
                  className="block text-sm text-primary hover:underline"
                >
                  Return to sign in
                </a>
              </div>
            ) : complete ? (
              <div className="flex flex-col gap-4">
                <p role="status">
                  Your password has been reset and existing sessions were
                  revoked.
                </p>
                <a href="/login" className="text-primary hover:underline">
                  Sign in with the new password
                </a>
              </div>
            ) : (
              <form
                className="flex flex-col gap-5"
                onSubmit={(event) => void submit(event)}
              >
                <Field
                  data-invalid={fieldError === undefined ? undefined : true}
                >
                  <FieldLabel htmlFor="reset-password">New password</FieldLabel>
                  <Input
                    id="reset-password"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    maxLength={128}
                    required
                    value={password}
                    disabled={pending}
                    aria-invalid={fieldError === undefined ? undefined : true}
                    aria-describedby={
                      fieldError === undefined
                        ? 'reset-password-help'
                        : 'reset-password-help reset-password-error'
                    }
                    onChange={(event) => {
                      setPassword(event.target.value);
                      if (fieldError !== undefined)
                        setFieldError(
                          event.target.value.length >= 12
                            ? undefined
                            : 'Use at least 12 characters.',
                        );
                    }}
                  />
                  <FieldDescription id="reset-password-help">
                    Use at least 12 characters.
                  </FieldDescription>
                  {fieldError === undefined ? null : (
                    <FieldError id="reset-password-error">
                      {fieldError}
                    </FieldError>
                  )}
                </Field>
                {requestError === undefined ? null : (
                  <p role="alert" className="text-sm text-destructive">
                    {requestError}
                  </p>
                )}
                <Button type="submit" size="lg" disabled={pending}>
                  {pending ? 'Resetting password…' : 'Reset password'}
                </Button>
                <div className="flex gap-4 text-sm">
                  <a href="/login" className="text-primary hover:underline">
                    Try signing in
                  </a>
                  <a
                    href="/forgot-password"
                    className="text-primary hover:underline"
                  >
                    Request a new link
                  </a>
                </div>
              </form>
            )}
          </GlassSectionContent>
        </GlassSection>
      </AuroraLoadingPanel>
    </AuthenticationShell>
  );
}

function resetFailureMessage(error: unknown): string {
  if (error instanceof NativeAuthenticationError) {
    if (error.code === 'auth.reset_link_invalid' || error.status === 400)
      return 'This reset link is invalid or expired. Request a new one.';
    if (error.status === 429)
      return 'Too many reset attempts. Wait a moment before trying again.';
    if (error.kind === 'network' || error.kind === 'timeout')
      return 'The response was lost. Your password may have changed; try signing in with the new password before requesting another link.';
  }
  return 'The reset could not be confirmed. Try signing in with the new password, or request another link.';
}
