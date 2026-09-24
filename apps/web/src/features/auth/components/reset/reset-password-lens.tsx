import { Link } from '@tanstack/react-router';
import type { SyntheticEvent } from 'react';
import type { ApiClient } from '@/lib/api/client';
import {
  confirmationProblem,
  newPasswordProblem,
} from '../../forms/field-rules';
import { PasswordField } from '../../forms/password-field';
import { ProgressButton } from '../../forms/progress-button';
import { useValidatedFields } from '../../forms/use-validated-fields';
import { resetFailure } from '../../model/auth-failure';
import { resetPassword } from '../../native-auth.api';
import { useAuthRequest } from '../../use-auth-request';
import {
  AuthLens,
  AuthLensDescription,
  AuthLensFooter,
  AuthLensTitle,
  AuthStatusLine,
} from '../stage/auth-lens';

/** New password plus confirmation for a one-time reset link. */
export function ResetPasswordLens({
  apiClient,
  token,
  minimumPasswordLength,
  onReset,
}: Readonly<{
  apiClient: ApiClient;
  token: string;
  minimumPasswordLength: number;
  onReset: () => void;
}>) {
  const fields = useValidatedFields(
    {
      password: (value) => newPasswordProblem(value, minimumPasswordLength),
      confirmation: (value, values) =>
        confirmationProblem(value, values.password),
    },
    { password: '', confirmation: '' },
  );
  const request = useAuthRequest(resetFailure);
  const { pending, failure } = request;

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const values = fields.validateAll();
    if (values === undefined) return;
    await request.run(
      (signal) =>
        resetPassword(apiClient, { token, password: values.password }, signal),
      () => {
        fields.reset();
        onReset();
      },
    );
  }

  return (
    <AuthLens pending={pending} aria-labelledby="reset-title">
      <AuthLensTitle id="reset-title">Choose a new password</AuthLensTitle>
      <AuthLensDescription>
        Saving it signs you out on every other device.
      </AuthLensDescription>
      <form
        noValidate
        className="mt-6 flex flex-col gap-4"
        onSubmit={(event) => void submit(event)}
      >
        <PasswordField
          id="reset-password"
          label="New password"
          autoComplete="new-password"
          minimumLength={minimumPasswordLength}
          disabled={pending}
          error={fields.errors.password}
          state={fields.threadState('password')}
          {...fields.inputProps('password')}
        />
        <PasswordField
          id="reset-confirmation"
          label="Confirm new password"
          autoComplete="new-password"
          disabled={pending}
          error={fields.errors.confirmation}
          state={fields.threadState('confirmation')}
          {...fields.inputProps('confirmation')}
        />
        {failure === undefined ? null : (
          <AuthStatusLine tone="failure">{failure}</AuthStatusLine>
        )}
        <ProgressButton
          type="submit"
          variant="primary"
          size="lg"
          className="mt-1 w-full"
          pending={pending}
          pendingLabel="Saving…"
          waitSeconds={request.waitSeconds}
        >
          Reset password
        </ProgressButton>
      </form>
      <AuthLensFooter className="flex flex-wrap justify-center gap-x-5 gap-y-1">
        <Link to="/login">Try signing in</Link>
        <Link to="/forgot-password">Request a new link</Link>
      </AuthLensFooter>
    </AuthLens>
  );
}
