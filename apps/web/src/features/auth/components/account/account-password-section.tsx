import type { AccountSecurityResponse } from '@pertexo/contracts/schemas/identity-workspace';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type SyntheticEvent } from 'react';
import { useFieldValues } from '@/components/ui/use-field-validation';
import { useNotifications } from '@/components/ui/use-notifications';
import { isApiError } from '@/lib/api/api-error';
import type { ApiClient } from '@/lib/api/client';
import {
  changeAccountPassword,
  setupAccountPassword,
} from '../../account-security.api';
import { accountSecurityKeys } from '../../account-security.queries';
import {
  confirmationProblem,
  DEFAULT_MINIMUM_PASSWORD_LENGTH,
  newPasswordProblem,
  requiredPasswordProblem,
} from '../../forms/field-rules';
import { PasswordField } from '../../forms/password-field';
import { ProgressButton } from '@/components/ui/progress-button';
import { useLatestRequest } from '../../use-latest-request';
import { AccountCommandFailure, AccountSection } from './account-section';

// The account endpoints accept new passwords of at least 12 characters.
const MINIMUM_LENGTH = DEFAULT_MINIMUM_PASSWORD_LENGTH;

/**
 * Change the password, or set one up for an account that only signs in with
 * a provider. Passwords stay in the form, never in a query or mutation cache.
 */
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
  const fields = useFieldValues(
    {
      current: (value) =>
        hasPassword ? requiredPasswordProblem(value) : undefined,
      password: (value) => newPasswordProblem(value, MINIMUM_LENGTH),
      confirmation: (value, values) =>
        confirmationProblem(value, values.password),
    },
    { current: '', password: '', confirmation: '' },
  );
  const requests = useLatestRequest();
  const queryClient = useQueryClient();
  const notifications = useNotifications();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<unknown>();

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const values = fields.validate();
    if (values === undefined) return;
    const request = requests.begin();
    const { current, password } = values;
    setPending(true);
    setFailure(undefined);
    try {
      if (hasPassword)
        await changeAccountPassword(
          apiClient,
          { currentPassword: current, newPassword: password },
          request.signal,
        );
      else await setupAccountPassword(apiClient, password, request.signal);
      if (!request.isCurrent()) return;
      fields.reset();
      notifications.success({
        title: hasPassword ? 'Password changed' : 'Password added',
        description: 'Your other devices were signed out.',
      });
      await queryClient.invalidateQueries({
        queryKey: accountSecurityKeys.scope(userId),
      });
    } catch (error) {
      if (request.isCurrent()) setFailure(error);
    } finally {
      if (request.finish()) setPending(false);
    }
  }

  return (
    <AccountSection
      id="account-password-title"
      title={hasPassword ? 'Password' : 'Add a password'}
      description={
        hasPassword
          ? 'Changing it signs you out on your other devices.'
          : 'Sign in with an email and password as well as your provider.'
      }
    >
      <form
        noValidate
        className="flex max-w-md flex-col gap-4"
        onSubmit={(event) => void submit(event)}
      >
        {hasPassword ? (
          <PasswordField
            id="account-current-password"
            label="Current password"
            autoComplete="current-password"
            disabled={pending}
            {...fields.field('current')}
            {...fields.control('current')}
          />
        ) : null}
        <PasswordField
          id="account-new-password"
          label="New password"
          autoComplete="new-password"
          minimumLength={MINIMUM_LENGTH}
          disabled={pending}
          {...fields.field('password')}
          {...fields.control('password')}
        />
        <PasswordField
          id="account-confirm-password"
          label="Confirm new password"
          autoComplete="new-password"
          disabled={pending}
          {...fields.field('confirmation')}
          {...fields.control('confirmation')}
        />
        {failure === undefined ? null : (
          <AccountCommandFailure
            error={failure}
            action={
              hasPassword ? 'changing your password' : 'adding a password'
            }
            message={
              hasPassword && isApiError(failure) && failure.status === 400
                ? 'Your current password wasn’t accepted. Check it and try again.'
                : undefined
            }
          />
        )}
        <ProgressButton
          type="submit"
          className="w-fit"
          pending={pending}
          pendingLabel="Saving…"
        >
          {hasPassword ? 'Change password' : 'Add password'}
        </ProgressButton>
      </form>
    </AccountSection>
  );
}
