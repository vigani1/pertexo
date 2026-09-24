import type { ReactNode, SyntheticEvent } from 'react';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useFieldValues } from '@/components/ui/use-field-validation';
import { emailProblem } from '../../forms/field-rules';
import { ProgressButton } from '@/components/ui/progress-button';
import { useAuthRequest } from '../../use-auth-request';
import {
  AuthLens,
  AuthLensDescription,
  AuthLensTitle,
} from '../stage/auth-lens';
import { Notice } from '@/components/ui/notice';

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

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const values = fields.validate();
    if (values === undefined) return;
    const email = values.email.trim();
    await request.run(
      (signal) => send(email, signal),
      () => {
        onSent(email);
      },
    );
  }

  return (
    <AuthLens pending={pending} aria-labelledby={`${id}-title`}>
      <AuthLensTitle id={`${id}-title`}>{title}</AuthLensTitle>
      <AuthLensDescription>{description}</AuthLensDescription>
      <form
        noValidate
        className="mt-6 flex flex-col gap-4"
        onSubmit={(event) => void submit(event)}
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
        {failure === undefined ? null : (
          <Notice tone="destructive">{failure}</Notice>
        )}
        <ProgressButton
          type="submit"
          variant="primary"
          size="lg"
          className="mt-1 w-full"
          pending={pending}
          pendingLabel={pendingLabel}
          waitSeconds={request.waitSeconds}
        >
          {submitLabel}
        </ProgressButton>
      </form>
      {footer}
    </AuthLens>
  );
}
