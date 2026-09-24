import type { ReactNode } from 'react';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useFieldValues } from '@/components/ui/use-field-validation';
import { emailProblem } from '../../forms/field-rules';
import { useAuthRequest } from '../../use-auth-request';
import {
  AuthLens,
  AuthLensDescription,
  AuthLensTitle,
} from '../stage/auth-lens';
import { AuthForm } from '../../forms/auth-form';

/**
 * One email field that asks Pertexo to send something (a reset link, a new
 * verification link). The answer is deliberately the same whether or not an
 * account exists, so success always hands over to the "check your inbox" lens.
 */
export function EmailRequestLens({
  id,
  title,
  description,
  submitLabel,
  pendingLabel,
  send,
  describeFailure,
  onSent,
  footer,
}: Readonly<{
  id: string;
  title: string;
  description: ReactNode;
  submitLabel: string;
  pendingLabel: string;
  send: (email: string, signal: AbortSignal) => Promise<unknown>;
  describeFailure: (error: unknown) => string;
  onSent: (email: string) => void;
  footer?: ReactNode;
}>) {
  const fields = useFieldValues({ email: emailProblem }, { email: '' });
  const request = useAuthRequest(describeFailure);
  const { pending, failure } = request;

  return (
    <AuthLens pending={pending} aria-labelledby={`${id}-title`}>
      <AuthLensTitle id={`${id}-title`}>{title}</AuthLensTitle>
      <AuthLensDescription>{description}</AuthLensDescription>
      <AuthForm
        className="mt-6"
        failure={failure}
        pending={pending}
        pendingLabel={pendingLabel}
        submitLabel={submitLabel}
        waitSeconds={request.waitSeconds}
        onSubmit={() =>
          void request.submit(
            fields.validate,
            (values, signal) => send(values.email.trim(), signal),
            (values) => {
              onSent(values.email.trim());
            },
          )
        }
      >
        <LabelledField
          id={`${id}-email`}
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
      </AuthForm>
      {footer}
    </AuthLens>
  );
}
