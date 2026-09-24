import type { AccountSecurityResponse } from '@pertexo/contracts/schemas/identity-workspace';
import { useRef, useState, type SyntheticEvent } from 'react';
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
import { useRequestAccountEmailChange } from '../account-security.mutations';

export function AccountEmailSection({
  apiClient,
  security,
}: Readonly<{ apiClient: ApiClient; security: AccountSecurityResponse }>) {
  const [email, setEmail] = useState('');
  const [validationError, setValidationError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const mutation = useRequestAccountEmailChange(apiClient);

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !email.includes('@') ||
      email.trim().toLowerCase() === security.email.toLowerCase()
    ) {
      setValidationError('Enter a different valid email address.');
      input.current?.focus();
      return;
    }
    setValidationError(undefined);
    mutation.reset();
    mutation.mutate(email.trim());
  }

  return (
    <GlassSection>
      <GlassSectionHeader>
        <GlassSectionTitle>Contact email</GlassSectionTitle>
        <GlassSectionDescription>
          Your current verified email is {security.email}. A change is confirmed
          through the old address and then verified at the new address.
          Completion ends all sessions and returns you to sign in.
        </GlassSectionDescription>
      </GlassSectionHeader>
      <GlassSectionContent>
        <form className="grid max-w-lg gap-4" onSubmit={submit} noValidate>
          <label className="grid gap-2 text-sm font-medium">
            New email
            <Input
              ref={input}
              type="email"
              autoComplete="email"
              value={email}
              required
              disabled={mutation.isPending}
              aria-invalid={validationError !== undefined}
              aria-describedby={
                validationError === undefined ? undefined : 'email-change-error'
              }
              onChange={(event) => {
                const nextEmail = event.target.value;
                setEmail(nextEmail);
                mutation.reset();
                if (validationError !== undefined)
                  setValidationError(
                    nextEmail.includes('@') &&
                      nextEmail.trim().toLowerCase() !==
                        security.email.toLowerCase()
                      ? undefined
                      : 'Enter a different valid email address.',
                  );
              }}
            />
          </label>
          {validationError === undefined ? null : (
            <p
              id="email-change-error"
              role="alert"
              className="text-sm text-destructive"
            >
              {validationError}
            </p>
          )}
          {mutation.error === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              {emailChangeError(mutation.error)}
            </p>
          )}
          {mutation.isSuccess ? (
            <p role="status" className="text-sm text-primary">
              Check your current email to continue the change.
            </p>
          ) : null}
          <Button type="submit" className="w-fit" disabled={mutation.isPending}>
            {mutation.isPending ? 'Requesting…' : 'Change email'}
          </Button>
        </form>
      </GlassSectionContent>
    </GlassSection>
  );
}

function emailChangeError(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 401) return 'Your session expired. Sign in again.';
    if (error.status === 403) return 'Email changes require a recent sign-in.';
    if (error.status === 400)
      return 'The email change could not be started. Check the address and try again.';
  }
  return 'The email change could not be started. Try again.';
}
