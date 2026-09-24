import { useState, type ReactNode, type SyntheticEvent } from 'react';
import { emailProblem } from '../../forms/field-rules';
import { ProgressButton } from '../../forms/progress-button';
import { TextField } from '@/components/patterns/text-field';
import { useValidatedFields } from '../../forms/use-validated-fields';
import { rateLimitSeconds } from '../../model/auth-failure';
import { useCountdown } from '../../use-countdown';
import { useLatestRequest } from '../../use-latest-request';
import {
  AuthLens,
  AuthLensDescription,
  AuthLensTitle,
  AuthStatusLine,
} from '../stage/auth-lens';

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
  const fields = useValidatedFields({ email: emailProblem }, { email: '' });
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
      await send(email, request.signal);
      if (request.isCurrent()) onSent(email);
    } catch (error) {
      if (!request.isCurrent()) return;
      const seconds = rateLimitSeconds(error);
      if (seconds !== undefined) rateLimit.startSeconds(seconds);
      setFailure(describeFailure(error));
    } finally {
      if (request.finish()) setPending(false);
    }
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
        <TextField
          id={`${id}-email`}
          label="Email"
          type="email"
          autoComplete="email"
          disabled={pending}
          error={fields.errors.email}
          state={fields.threadState('email')}
          {...fields.inputProps('email')}
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
          pendingLabel={pendingLabel}
          waitSeconds={rateLimit.remainingSeconds}
        >
          {submitLabel}
        </ProgressButton>
      </form>
      {footer}
    </AuthLens>
  );
}
