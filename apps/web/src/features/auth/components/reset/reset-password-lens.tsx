import { Link } from '@tanstack/react-router';
import { useState, type SyntheticEvent } from 'react';
import type { ApiClient } from '@/lib/api/client';
import {
  confirmationProblem,
  newPasswordProblem,
} from '../../forms/field-rules';
import { PasswordField } from '../../forms/password-field';
import { ProgressButton } from '../../forms/progress-button';
import { useValidatedFields } from '../../forms/use-validated-fields';
import { rateLimitSeconds, resetFailure } from '../../model/auth-failure';
import { resetPassword } from '../../native-auth.api';
import { useCountdown } from '../../use-countdown';
import { useLatestRequest } from '../../use-latest-request';
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
  const requests = useLatestRequest();
  const rateLimit = useCountdown();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const values = fields.validateAll();
    if (values === undefined) return;
    const request = requests.begin();
    setPending(true);
    setFailure(undefined);
    try {
      await resetPassword(
        apiClient,
        { token, password: values.password },
        request.signal,
      );
      if (!request.isCurrent()) return;
      fields.reset();
      onReset();
    } catch (error) {
      if (!request.isCurrent()) return;
      const seconds = rateLimitSeconds(error);
      if (seconds !== undefined) rateLimit.startSeconds(seconds);
      setFailure(resetFailure(error));
    } finally {
      if (request.finish()) setPending(false);
    }
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
          waitSeconds={rateLimit.remainingSeconds}
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
