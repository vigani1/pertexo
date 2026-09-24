import type { AccountSecurityResponse } from '@pertexo/contracts/schemas/identity-workspace';
import type { SyntheticEvent } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { useRequestAccountEmailChange } from '../../account-security.mutations';
import { emailProblem } from '../../forms/field-rules';
import { ProgressButton } from '../../forms/progress-button';
import { TextField } from '@/components/patterns/text-field';
import { useValidatedFields } from '../../forms/use-validated-fields';
import { AuthStatusLine } from '../stage/auth-lens';
import { AccountCommandFailure, AccountSection } from './account-section';

/** Change email: confirmed at the old address, then verified at the new. */
export function AccountEmailSection({
  apiClient,
  security,
}: Readonly<{ apiClient: ApiClient; security: AccountSecurityResponse }>) {
  const mutation = useRequestAccountEmailChange(apiClient);
  const fields = useValidatedFields(
    {
      email: (value) =>
        emailProblem(value) ??
        (value.trim().toLowerCase() === security.email.toLowerCase()
          ? 'That’s your current email. Enter a different one.'
          : undefined),
    },
    { email: '' },
  );

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending) return;
    const values = fields.validateAll();
    if (values === undefined) return;
    mutation.reset();
    mutation.mutate(values.email.trim());
  }

  return (
    <AccountSection
      id="account-email-title"
      title="Change email"
      description="We confirm it at your current address, then at the new one. Finishing signs you out everywhere."
    >
      <form
        noValidate
        className="flex max-w-md flex-col gap-4"
        onSubmit={submit}
      >
        <TextField
          id="account-new-email"
          label="New email"
          type="email"
          autoComplete="email"
          disabled={mutation.isPending}
          error={fields.errors.email}
          state={fields.threadState('email')}
          {...fields.inputProps('email')}
          onChange={(event) => {
            mutation.reset();
            fields.setValue('email', event.target.value);
          }}
        />
        {mutation.error === null ? null : (
          <AccountCommandFailure
            error={mutation.error}
            action="changing your email"
          />
        )}
        {mutation.isSuccess ? (
          <AuthStatusLine tone="waiting">
            Check your current inbox to confirm the change. Then verify the new
            address.
          </AuthStatusLine>
        ) : null}
        <ProgressButton
          type="submit"
          className="w-fit"
          pending={mutation.isPending}
          pendingLabel="Sending…"
        >
          Change email
        </ProgressButton>
      </form>
    </AccountSection>
  );
}
