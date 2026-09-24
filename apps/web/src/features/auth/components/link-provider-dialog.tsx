import {
  authenticationProviderSchema,
  type AccountSecurityLinkStartRequest,
  type AccountSecurityResponse,
} from '@pertexo/contracts/schemas/identity-workspace';
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/api-error';
import { startAccountLink } from '../account-security.api';

type Provider = AccountSecurityResponse['availableProviders'][number];

export function LinkProviderDialog({
  apiClient,
  target,
  methods,
  onClose,
  navigateToProvider,
}: Readonly<{
  apiClient: ApiClient;
  target: Provider;
  methods: AccountSecurityResponse['methods'];
  onClose(): void;
  navigateToProvider(url: string): void;
}>) {
  const sourceMethods = methods.filter(
    (method) => method.kind === 'password' || method.provider !== target,
  );
  const [source, setSource] = useState(sourceMethods[0]?.id ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const active = useRef<AbortController | undefined>(undefined);
  useEffect(
    () => () => {
      active.current?.abort();
      active.current = undefined;
    },
    [],
  );
  const selected = sourceMethods.find((method) => method.id === source);

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || selected === undefined) return;
    if (selected.kind === 'password' && password.length === 0) {
      setError('Enter your current password to verify this linking attempt.');
      passwordRef.current?.focus();
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setError(undefined);
    setPending(true);
    try {
      const existingMethod: AccountSecurityLinkStartRequest['existingMethod'] =
        selected.kind === 'password'
          ? { kind: 'password', password }
          : {
              kind: 'social',
              provider: authenticationProviderSchema.parse(selected.provider),
            };
      const url = await startAccountLink(
        apiClient,
        {
          provider: target,
          existingMethod,
        },
        controller.signal,
      );
      if (active.current === controller && !controller.signal.aborted) {
        setPassword('');
        navigateToProvider(url);
      }
    } catch (failure) {
      if (active.current === controller && !controller.signal.aborted)
        setError(linkError(failure));
    } finally {
      if (active.current === controller) {
        active.current = undefined;
        setPending(false);
      }
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          active.current?.abort();
          setPassword('');
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogTitle>Link {providerName(target)}?</DialogTitle>
        <DialogDescription>
          Confirm an existing sign-in method, then authorize{' '}
          {providerName(target)}
          in this browser. Both proofs must finish within five minutes. Matching
          email addresses alone do not link accounts; other sessions end after a
          successful link.
        </DialogDescription>
        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => void submit(event)}
        >
          <div className="space-y-2">
            <label
              htmlFor="link-existing-method"
              className="text-sm font-medium"
            >
              Existing method to verify
            </label>
            <select
              id="link-existing-method"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm"
              value={source}
              disabled={pending}
              onChange={(event) => {
                setSource(event.target.value);
                setPassword('');
                setError(undefined);
              }}
            >
              {sourceMethods.map((method) => (
                <option key={method.id} value={method.id}>
                  {method.kind === 'password'
                    ? 'Password'
                    : providerName(method.provider ?? 'provider')}
                </option>
              ))}
            </select>
          </div>
          {selected?.kind === 'password' ? (
            <div className="space-y-2">
              <label
                htmlFor="link-current-password"
                className="text-sm font-medium"
              >
                Current password
              </label>
              <input
                ref={passwordRef}
                id="link-current-password"
                type="password"
                autoComplete="current-password"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm"
                value={password}
                disabled={pending}
                aria-invalid={error !== undefined && password.length === 0}
                aria-describedby={
                  error === undefined ? undefined : 'link-method-error'
                }
                onChange={(event) => {
                  setPassword(event.target.value);
                  if (error !== undefined && event.target.value.length > 0)
                    setError(undefined);
                }}
              />
            </div>
          ) : null}
          {error === undefined ? null : (
            <p
              id="link-method-error"
              role="alert"
              className="text-sm text-destructive"
            >
              {error}
            </p>
          )}
          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                active.current?.abort();
                setPassword('');
                onClose();
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || selected === undefined}>
              {pending ? 'Verifying…' : 'Continue to provider'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function providerName(value: string): string {
  return value === 'github'
    ? 'GitHub'
    : `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function linkError(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 401) return 'Your session ended. Sign in again.';
    if (error.status === 403)
      return 'The existing method could not be verified.';
    if (error.status === 409)
      return 'This provider is already linked. Refresh your methods.';
    if (error.status === 503)
      return 'The provider is unavailable. Try again later.';
  }
  return 'Linking could not start. Your existing methods were not changed.';
}
