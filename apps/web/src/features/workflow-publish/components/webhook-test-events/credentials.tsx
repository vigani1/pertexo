import type { WebhookTestEventStarted } from '@pertexo/contracts';
import { CopyButton } from '@/components/ui/copy-button';
export function ListenerCredentials({
  listener,
  remainingSeconds,
}: {
  listener: WebhookTestEventStarted;
  remainingSeconds: number;
}) {
  const url = new URL(listener.path, window.location.origin).href;
  const policy = listener.authentication;
  return (
    <>
      <p className="text-xs text-muted-foreground">
        {String(remainingSeconds)} seconds left. Test credentials are separate
        from production.
      </p>
      <div className="flex min-w-0 items-start gap-2">
        <code className="min-w-0 flex-1 break-all text-xs">{url}</code>
        <CopyButton value={url} label="Copy test URL" />
      </div>
      {listener.signingSecret === undefined ? null : (
        <div className="flex min-w-0 items-start gap-2">
          <span className="text-xs">
            {policy.mode === 'signed' ? 'Signing secret' : 'Header secret'}{' '}
            (shown once)
          </span>
          <CopyButton value={listener.signingSecret} label="Copy test secret" />
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {policy.mode === 'signed'
          ? 'Use the normal Pertexo timestamp and HMAC signature headers.'
          : policy.mode === 'header_secret'
            ? `Send ${policy.headerName}${policy.headerName === 'authorization' ? ': Bearer <secret>' : ': <secret>'}.`
            : 'Send a request to this secret URL.'}
      </p>
    </>
  );
}
