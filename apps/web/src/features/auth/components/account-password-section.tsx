import type { AccountSecurityResponse } from '@pertexo/contracts/schemas/identity-workspace';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import {
  GlassSection,
  GlassSectionContent,
  GlassSectionDescription,
  GlassSectionHeader,
  GlassSectionTitle,
} from '@/components/patterns/glass-section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/api-error';
import {
  changeAccountPassword,
  setupAccountPassword,
} from '../account-security.api';
import { accountSecurityKeys } from '../account-security.queries';

export function AccountPasswordSection({
  apiClient,
  userId,
  security,
}: Readonly<{
  apiClient: ApiClient;
  userId: string;
  security: AccountSecurityResponse;
}>) {
  const hasPassword = security.methods.some(
    (method) => method.kind === 'password',
  );
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [validationError, setValidationError] = useState<string>();
  const [requestError, setRequestError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  const [complete, setComplete] = useState(false);
  const firstInput = useRef<HTMLInputElement>(null);
  const activeRequest = useRef<AbortController | undefined>(undefined);
  const queryClient = useQueryClient();
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
    if (newPassword.length < 12) {
      setValidationError('Use at least 12 characters.');
      firstInput.current?.focus();
      return;
    }
    if (newPassword !== confirmation) {
      setValidationError('The new passwords do not match.');
      return;
    }
    setValidationError(undefined);
    setRequestError(undefined);
    setComplete(false);
    const controller = new AbortController();
    activeRequest.current = controller;
    setPending(true);
    try {
      if (hasPassword)
        await changeAccountPassword(
          apiClient,
          { currentPassword, newPassword },
          controller.signal,
        );
      else
        await setupAccountPassword(apiClient, newPassword, controller.signal);
      if (controller.signal.aborted) return;
      setCurrentPassword('');
      setNewPassword('');
      setConfirmation('');
      setComplete(true);
      await queryClient.invalidateQueries({
        queryKey: accountSecurityKeys.scope(userId),
      });
    } catch (error) {
      if (!controller.signal.aborted) setRequestError(error);
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = undefined;
        setPending(false);
      }
    }
  }

  return (
    <GlassSection>
      <GlassSectionHeader>
        <GlassSectionTitle>
          {hasPassword ? 'Change password' : 'Add a password'}
        </GlassSectionTitle>
        <GlassSectionDescription>
          {hasPassword
            ? 'Changing your password ends every other browser session and rotates this one.'
            : 'Add a password after a recent social sign-in. This ends other browser sessions.'}
        </GlassSectionDescription>
      </GlassSectionHeader>
      <GlassSectionContent>
        <form
          className="grid max-w-lg gap-4"
          onSubmit={(event) => void submit(event)}
          noValidate
        >
          {hasPassword ? (
            <label className="grid gap-2 text-sm font-medium">
              Current password
              <Input
                ref={firstInput}
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                required
                onChange={(event) => {
                  setCurrentPassword(event.target.value);
                }}
              />
            </label>
          ) : null}
          <label className="grid gap-2 text-sm font-medium">
            New password
            <Input
              ref={hasPassword ? undefined : firstInput}
              type="password"
              autoComplete="new-password"
              value={newPassword}
              minLength={12}
              maxLength={128}
              required
              aria-invalid={validationError !== undefined}
              aria-describedby={
                validationError === undefined ? undefined : 'password-error'
              }
              onChange={(event) => {
                setNewPassword(event.target.value);
              }}
            />
          </label>
          <label className="grid gap-2 text-sm font-medium">
            Confirm new password
            <Input
              type="password"
              autoComplete="new-password"
              value={confirmation}
              required
              aria-invalid={validationError !== undefined}
              aria-describedby={
                validationError === undefined ? undefined : 'password-error'
              }
              onChange={(event) => {
                setConfirmation(event.target.value);
              }}
            />
          </label>
          {validationError === undefined ? null : (
            <p
              id="password-error"
              role="alert"
              className="text-sm text-destructive"
            >
              {validationError}
            </p>
          )}
          {requestError === undefined ? null : (
            <p role="alert" className="text-sm text-destructive">
              {passwordError(requestError)}
            </p>
          )}
          {complete ? (
            <p role="status" className="text-sm text-primary">
              Password updated. Other browser sessions were ended.
            </p>
          ) : null}
          <Button type="submit" className="w-fit" disabled={pending}>
            {pending
              ? 'Updating…'
              : hasPassword
                ? 'Change password'
                : 'Add password'}
          </Button>
        </form>
      </GlassSectionContent>
    </GlassSection>
  );
}

function passwordError(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 401) return 'Your session expired. Sign in again.';
    if (error.status === 403) return 'This change requires a recent sign-in.';
    if (error.status === 400) return 'The current password was not accepted.';
  }
  return 'The password could not be updated. Try again.';
}
