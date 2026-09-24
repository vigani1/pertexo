import { Link } from '@tanstack/react-router';
import type { SyntheticEvent } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { emailProblem, newPasswordProblem } from '../../forms/field-rules';
import { PasswordField } from '../../forms/password-field';
import { ProgressButton } from '../../forms/progress-button';
import { TextField } from '@/components/patterns/text-field';
import { useValidatedFields } from '../../forms/use-validated-fields';
import { signUpFailure } from '../../model/auth-failure';
import { signUpWithEmail } from '../../native-auth.api';
import { useAuthRequest } from '../../use-auth-request';
import {
  AuthLens,
  AuthLensDescription,
  AuthLensFooter,
  AuthLensTitle,
  AuthStatusLine,
} from '../stage/auth-lens';

function nameProblem(value: string): string | undefined {
  if (value.trim().length === 0)
    return 'Add your name so teammates recognise you.';
  return value.trim().length > 256 ? 'Use 256 characters or fewer.' : undefined;
}

/** Name, email and a password with its requirement thread. */
export function SignUpLens({
  apiClient,
  minimumPasswordLength,
  onCreated,
}: Readonly<{
  apiClient: ApiClient;
  minimumPasswordLength: number;
  onCreated: (email: string) => void;
}>) {
  const fields = useValidatedFields(
    {
      name: nameProblem,
      email: emailProblem,
      password: (value) => newPasswordProblem(value, minimumPasswordLength),
    },
    { name: '', email: '', password: '' },
  );
  const request = useAuthRequest(signUpFailure);
  const { pending, failure } = request;

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const values = fields.validateAll();
    if (values === undefined) return;
    const email = values.email.trim();
    await request.run(
      (signal) =>
        signUpWithEmail(
          apiClient,
          {
            displayName: values.name.trim(),
            email,
            password: values.password,
          },
          signal,
        ),
      () => {
        fields.reset({ ...values, password: '' });
        onCreated(email);
      },
    );
  }

  return (
    <AuthLens pending={pending} aria-labelledby="sign-up-title">
      <AuthLensTitle id="sign-up-title">Create your account</AuthLensTitle>
      <AuthLensDescription>
        Verify your email first. Workspace access comes from an invitation or a
        workspace you create.
      </AuthLensDescription>
      <form
        noValidate
        className="mt-6 flex flex-col gap-4"
        onSubmit={(event) => void submit(event)}
      >
        <TextField
          id="sign-up-name"
          label="Your name"
          autoComplete="name"
          maxLength={256}
          disabled={pending}
          error={fields.errors.name}
          state={fields.threadState('name')}
          {...fields.inputProps('name')}
        />
        <TextField
          id="sign-up-email"
          label="Email"
          type="email"
          autoComplete="email"
          disabled={pending}
          error={fields.errors.email}
          state={fields.threadState('email')}
          {...fields.inputProps('email')}
        />
        <PasswordField
          id="sign-up-password"
          label="Password"
          autoComplete="new-password"
          minimumLength={minimumPasswordLength}
          disabled={pending}
          error={fields.errors.password}
          state={fields.threadState('password')}
          {...fields.inputProps('password')}
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
          pendingLabel="Creating account…"
          waitSeconds={request.waitSeconds}
        >
          Create account
        </ProgressButton>
      </form>
      <AuthLensFooter>
        Already have an account? <Link to="/login">Sign in</Link>
      </AuthLensFooter>
    </AuthLens>
  );
}
