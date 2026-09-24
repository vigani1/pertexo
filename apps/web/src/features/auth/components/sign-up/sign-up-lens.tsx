import { Link } from '@tanstack/react-router';
import { useState, type SyntheticEvent } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { emailProblem, newPasswordProblem } from '../../forms/field-rules';
import { PasswordField } from '../../forms/password-field';
import { ProgressButton } from '../../forms/progress-button';
import { TextField } from '@/components/patterns/text-field';
import { useValidatedFields } from '../../forms/use-validated-fields';
import { rateLimitSeconds, signUpFailure } from '../../model/auth-failure';
import { signUpWithEmail } from '../../native-auth.api';
import { useCountdown } from '../../use-countdown';
import { useLatestRequest } from '../../use-latest-request';
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
  const requests = useLatestRequest();
  const rateLimit = useCountdown();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const values = fields.validateAll();
    if (values === undefined) return;
    const email = values.email.trim();
    const request = requests.begin();
    setPending(true);
    setFailure(undefined);
    try {
      await signUpWithEmail(
        apiClient,
        {
          displayName: values.name.trim(),
          email,
          password: values.password,
        },
        request.signal,
      );
      if (!request.isCurrent()) return;
      fields.reset({ ...values, password: '' });
      onCreated(email);
    } catch (error) {
      if (!request.isCurrent()) return;
      const seconds = rateLimitSeconds(error);
      if (seconds !== undefined) rateLimit.startSeconds(seconds);
      setFailure(signUpFailure(error));
    } finally {
      if (request.finish()) setPending(false);
    }
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
          waitSeconds={rateLimit.remainingSeconds}
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
