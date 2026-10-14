import type { ApiTokenMetadata } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { Status } from '@/components/ui/status';
import { formatDateTime, formatRelativeTime } from '@/lib/format/time';
import { SCOPE_COPY, TOKEN_STATUS } from '../model/copy';

export function TokenList({
  tokens,
  onRevoke,
}: Readonly<{
  tokens: readonly ApiTokenMetadata[];
  onRevoke: (token: ApiTokenMetadata) => void;
}>) {
  return (
    <ul aria-label="Your API tokens" className="flex flex-col">
      {tokens.map((token) => (
        <li
          key={token.id}
          className="flex min-w-0 flex-col gap-3 border-t border-border py-5 first:border-t-0"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="min-w-0 break-words font-semibold">{token.name}</h3>
            <div className="flex shrink-0 items-center gap-3">
              <Status tone={TOKEN_STATUS[token.status].tone}>
                {TOKEN_STATUS[token.status].label}
              </Status>
              {token.status === 'revoked' ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Revoke ${token.name}`}
                  onClick={() => {
                    onRevoke(token);
                  }}
                >
                  Revoke
                </Button>
              )}
            </div>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {token.scopes.map((scope) => SCOPE_COPY[scope].label).join(' · ')}
          </p>
          <dl className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
            <div>
              <dt className="text-subtle-foreground">Expires</dt>
              <dd className="mt-1">
                <time dateTime={token.expiresAt}>
                  {formatDateTime(token.expiresAt)}
                </time>
              </dd>
            </div>
            <div>
              <dt className="text-subtle-foreground">
                Last authenticated (approximate)
              </dt>
              <dd className="mt-1">
                {token.lastUsedAt === null ? (
                  'Not used yet'
                ) : (
                  <time
                    dateTime={token.lastUsedAt}
                    title={formatDateTime(token.lastUsedAt)}
                  >
                    {formatRelativeTime(token.lastUsedAt)}
                  </time>
                )}
              </dd>
            </div>
          </dl>
          {token.status !== 'membership_changed' ? null : (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Your membership changed after this token was created. Create a
              replacement with your current access.
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
