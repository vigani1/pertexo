import type { AccountSecurityResponse } from '@pertexo/contracts/schemas/identity-workspace';
import type { SyntheticEvent } from 'react';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useFieldValues } from '@/components/ui/use-field-validation';
import type { ApiClient } from '@/lib/api/client';
import { useRequestAccountEmailChange } from '../../account-security.mutations';
import { emailProblem } from '../../forms/field-rules';
import { ProgressButton } from '@/components/ui/progress-button';
import { AccountCommandFailure, AccountSection } from './account-section';
import { Notice } from '@/components/ui/notice';

/** Change email: confirmed at the old address, then verified at the new. */
export function AccountEmailSection({
  apiClient,
  security,
}: Readonly<{ apiClient: ApiClient; security: AccountSecurityResponse }>) {
  const mutation = useRequestAccountEmailChange(apiClient);
  const fields = useFieldValues(
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
    const values = fields.validate();
    if (values === undefined) return;
    mutation.reset();
    mutation.mutate(values.email.trim());
  }

  return (
    <AccountSection
      title="Change email"
      description="We confirm it at your current address, then at the new one. Finishing signs you out everywhere."
    >
      <form
        noValidate
        className="flex max-w-md flex-col gap-4"
        onSubmit={submit}
      >
        <LabelledField
          id="account-new-email"
          label="New email"
          {...fields.field('email')}
        >
          {(control) => (
            <Input
              {...control}
              type="email"
              autoComplete="email"
              disabled={mutation.isPending}
              {...fields.control('email')}
              onChange={(event) => {
                mutation.reset();
                fields.setValue('email', event.target.value);
              }}
            />
          )}
        </LabelledField>
        {mutation.error === null ? null : (
          <AccountCommandFailure
            error={mutation.error}
            action="changing your email"
          />
        )}
        {mutation.isSuccess ? (
          <Notice tone="info" glyph="waiting">
            Check your current inbox to confirm the change. Then verify the new
            address.
          </Notice>
        ) : null}
        <ProgressButton
          type="submit"
          variant="primary"
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
