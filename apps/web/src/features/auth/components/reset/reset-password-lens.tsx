import { Link } from '@tanstack/react-router';
import { useFieldValues } from '@/components/ui/use-field-validation';
import type { ApiClient } from '@/lib/api/client';
import {
  confirmationProblem,
  newPasswordProblem,
} from '../../forms/field-rules';
import { PasswordField } from '../../forms/password-field';
import { resetFailure } from '../../model/auth-failure';
import { resetPassword } from '../../native-auth.api';
import { useAuthRequest } from '../../use-auth-request';
import {
  AuthLens,
  AuthLensDescription,
  AuthLensFooter,
  AuthLensTitle,
} from '../stage/auth-lens';
import { AuthForm } from '../../forms/auth-form';

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
  const fields = useFieldValues(
    {
      password: (value) => newPasswordProblem(value, minimumPasswordLength),
      confirmation: (value, values) =>
        confirmationProblem(value, values.password),
    },
    { password: '', confirmation: '' },
  );
  const request = useAuthRequest(resetFailure);
  const { pending, failure } = request;

  return (
    <AuthLens pending={pending} aria-labelledby="reset-title">
      <AuthLensTitle id="reset-title">Choose a new password</AuthLensTitle>
      <AuthLensDescription>
        Saving it signs you out on every other device.
      </AuthLensDescription>
      <AuthForm
        className="mt-6"
        failure={failure}
        pending={pending}
        pendingLabel="Saving…"
        submitLabel="Reset password"
        waitSeconds={request.waitSeconds}
        onSubmit={() =>
          void request.submit(
            fields.validate,
            (values, signal) =>
              resetPassword(
                apiClient,
                { token, password: values.password },
                signal,
              ),
            () => {
              fields.reset();
              onReset();
            },
          )
        }
      >
        <PasswordField
          id="reset-password"
          label="New password"
          autoComplete="new-password"
          minimumLength={minimumPasswordLength}
          disabled={pending}
          {...fields.field('password')}
          {...fields.control('password')}
        />
        <PasswordField
          id="reset-confirmation"
          label="Confirm new password"
          autoComplete="new-password"
          disabled={pending}
          {...fields.field('confirmation')}
          {...fields.control('confirmation')}
        />
      </AuthForm>
      <AuthLensFooter className="flex flex-wrap justify-center gap-x-5 gap-y-1">
        <Link to="/login">Try signing in</Link>
        <Link to="/forgot-password">Request a new link</Link>
      </AuthLensFooter>
    </AuthLens>
  );
}
