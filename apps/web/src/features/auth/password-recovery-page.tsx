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
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { ApiClient } from '@/lib/api/client';
import { authenticationCapabilitiesQueryOptions } from './auth.queries';
import { AuthenticationShell } from './authentication-shell';
import {
  NativeAuthenticationError,
  requestPasswordReset,
} from './native-auth.api';

export function PasswordRecoveryPage({
  apiClient,
}: Readonly<{ apiClient: ApiClient }>) {
  const capabilities = useQuery(
    authenticationCapabilitiesQueryOptions(apiClient),
  );
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string>();
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
    if (pending) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError(undefined);
    try {
      await requestPasswordReset(apiClient, email.trim(), controller.signal);
      if (request.current !== controller || controller.signal.aborted) return;
      setComplete(true);
    } catch (failure) {
      if (request.current === controller && !controller.signal.aborted)
        setError(recoveryFailureMessage(failure));
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
        <GlassSection aria-labelledby="recovery-title" aria-busy={pending}>
          <GlassSectionHeader>
            <GlassSectionTitle id="recovery-title">
              Reset your password
            </GlassSectionTitle>
            <GlassSectionDescription>
              Enter your email. If it belongs to a password account, Pertexo
              will send a time-limited reset link.
            </GlassSectionDescription>
          </GlassSectionHeader>
          <GlassSectionContent>
            {capabilities.isPending ? (
              <p role="status">Checking password recovery availability…</p>
            ) : capabilities.isError || !capabilities.data.password.enabled ? (
              <div className="space-y-3" role="alert">
                <p>Password recovery is not available right now.</p>
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
            ) : complete ? (
              <p role="status" className="leading-relaxed">
                Check your email for the next step. The response is
                intentionally the same whether or not an account exists.
              </p>
            ) : (
              <form
                className="flex flex-col gap-5"
                onSubmit={(event) => void submit(event)}
              >
                <Field>
                  <FieldLabel htmlFor="recovery-email">Email</FieldLabel>
                  <Input
                    id="recovery-email"
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
                {error === undefined ? null : <FieldError>{error}</FieldError>}
                <Button type="submit" size="lg" disabled={pending}>
                  {pending ? 'Requesting reset…' : 'Send reset link'}
                </Button>
              </form>
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

function recoveryFailureMessage(error: unknown): string {
  if (error instanceof NativeAuthenticationError && error.status === 429)
    return 'Too many recovery requests. Wait a moment before trying again.';
  if (
    error instanceof NativeAuthenticationError &&
    (error.kind === 'network' || error.kind === 'timeout')
  )
    return 'The response was lost. A reset email may still arrive; check your inbox before requesting another.';
  return 'The recovery request could not be confirmed. Try again.';
}
