import { Link } from '@tanstack/react-router';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useFieldValues } from '@/components/ui/use-field-validation';
import type { ApiClient } from '@/lib/api/client';
import { emailProblem, newPasswordProblem } from '../../forms/field-rules';
import { PasswordField } from '../../forms/password-field';
import { signUpFailure } from '../../model/auth-failure';
import { signUpWithEmail } from '../../native-auth.api';
import { useAuthRequest } from '../../use-auth-request';
import {
  AuthLens,
  AuthLensDescription,
  AuthLensFooter,
  AuthLensTitle,
} from '../stage/auth-lens';
import { AuthForm } from '../../forms/auth-form';

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
  const fields = useFieldValues(
    {
      name: nameProblem,
      email: emailProblem,
      password: (value) => newPasswordProblem(value, minimumPasswordLength),
    },
    { name: '', email: '', password: '' },
  );
  const request = useAuthRequest(signUpFailure);
  const { pending, failure } = request;

  return (
    <AuthLens pending={pending} aria-labelledby="sign-up-title">
      <AuthLensTitle id="sign-up-title">Create your account</AuthLensTitle>
      <AuthLensDescription>
        Verify your email first. Workspace access comes from an invitation or a
        workspace you create.
      </AuthLensDescription>
      <AuthForm
        className="mt-6"
        failure={failure}
        pending={pending}
        pendingLabel="Creating account…"
        submitLabel="Create account"
        waitSeconds={request.waitSeconds}
        onSubmit={() =>
          void request.submit(
            fields.validate,
            (values, signal) =>
              signUpWithEmail(
                apiClient,
                {
                  displayName: values.name.trim(),
                  email: values.email.trim(),
                  password: values.password,
                },
                signal,
              ),
            (values) => {
              fields.reset({ ...values, password: '' });
              onCreated(values.email.trim());
            },
          )
        }
      >
        <LabelledField
          id="sign-up-name"
          label="Your name"
          {...fields.field('name')}
        >
          {(control) => (
            <Input
              {...control}
              autoComplete="name"
              maxLength={256}
              disabled={pending}
              {...fields.control('name')}
            />
          )}
        </LabelledField>
        <LabelledField
          id="sign-up-email"
          label="Email"
          {...fields.field('email')}
        >
          {(control) => (
            <Input
              {...control}
              type="email"
              autoComplete="email"
              disabled={pending}
              {...fields.control('email')}
            />
          )}
        </LabelledField>
        <PasswordField
          id="sign-up-password"
          label="Password"
          autoComplete="new-password"
          minimumLength={minimumPasswordLength}
          disabled={pending}
          {...fields.field('password')}
          {...fields.control('password')}
        />
      </AuthForm>
      <AuthLensFooter>
        Already have an account? <Link to="/login">Sign in</Link>
      </AuthLensFooter>
    </AuthLens>
  );
}
