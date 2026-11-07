import { SignInAction } from './sign-in-action';
import type { ReactNode } from 'react';
import { isApiError, isSessionExpired } from '@/lib/api/error';
import { describeReadError, supportReference } from '@/lib/api/error-copy';
import { useReadRetry } from '@/lib/hooks/use-read-retry';
import { ProgressButton } from '@/components/ui/progress-button';
import { CopyButton } from '@/components/ui/copy-button';

export function ReadRecovery({
  error,
  resource,
  retrying,
  retry,
  message,
  label = 'Retry',
  pendingLabel = 'Trying again…',
  disabled = false,
}: Readonly<{
  error: unknown;
  resource: string;
  retrying: boolean;
  retry: () => void;
  message?: ReactNode;
  label?: string;
  pendingLabel?: string;
  disabled?: boolean;
}>) {
  const waitSeconds = useReadRetry(error);
  const reference = supportReference(error);
  const expired = isSessionExpired(error);
  const inaccessible =
    isApiError(error) && [403, 404].includes(error.status ?? 0);
  let description =
    message === undefined ? describeReadError(error, resource) : message;
  if (expired || inaccessible) description = describeReadError(error, resource);
  if (isApiError(error) && error.status === 429)
    description =
      waitSeconds > 0
        ? `Too many requests. Try again in ${String(waitSeconds)} s.`
        : 'Too many requests. You can try again now.';
  let action = (
    <ProgressButton
      type="button"
      variant="outline"
      size="sm"
      pending={retrying}
      pendingLabel={pendingLabel}
      disabled={disabled}
      waitSeconds={waitSeconds}
      onClick={retry}
    >
      {label}
    </ProgressButton>
  );
  if (inaccessible)
    action = (
      <a className="underline" href="/">
        Go to Home
      </a>
    );
  if (expired) action = <SignInAction />;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span>{description}</span>
      {action}
      {reference === undefined ? null : (
        <CopyButton
          value={reference}
          label="Copy error ID"
          display={reference}
          className="max-w-full break-all"
        />
      )}
    </div>
  );
}
