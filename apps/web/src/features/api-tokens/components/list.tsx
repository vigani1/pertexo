import type { ApiTokenMetadata } from '@pertexo/contracts';
import { KeyRoundIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { statusToneText } from '@/components/ui/status-tone';
import { formatDateTime, formatRelativeTime } from '@/lib/format/time';
import { useNow } from '@/lib/hooks/use-now';
import { cn } from '@/lib/utils';
import { SCOPE_COPY, TOKEN_STATUS } from '../model/copy';

/**
 * Every token as a card: a key in its status ring, what it may do as chips,
 * and its lifetime as a thread from created to expiry with today marked, so
 * one about to run out stands out before a script breaks.
 */
export function TokenList({
  tokens,
  onRevoke,
}: Readonly<{
  tokens: readonly ApiTokenMetadata[];
  onRevoke: (token: ApiTokenMetadata) => void;
}>) {
  const nowMs = useNow({ intervalMs: 60_000 });
  return (
    <ul aria-label="Your API tokens" className="grid gap-3">
      {tokens.map((token) => {
        const status = TOKEN_STATUS[token.status];
        const live = token.status === 'active';
        return (
          <li
            key={token.id}
            className={cn(
              'flex min-w-0 flex-col gap-4 rounded-xl border border-surface-ink/7 bg-surface-ink/[0.02] p-5',
              !live && 'opacity-80',
            )}
          >
            <div className="flex min-w-0 items-start gap-3">
              <span
                aria-hidden="true"
                className={cn(
                  'grid size-9 shrink-0 place-items-center rounded-full border',
                  live
                    ? 'border-action/50 bg-action/8 text-accent-foreground'
                    : 'border-border text-subtle-foreground',
                )}
              >
                <KeyRoundIcon className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="min-w-0 font-semibold break-words">
                  {token.name}
                </h3>
                <p
                  className={cn(
                    'text-[0.78rem] font-medium',
                    statusToneText[status.tone],
                  )}
                >
                  {status.label}
                </p>
              </div>
              {token.status === 'revoked' ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0 hover:text-destructive"
                  aria-label={`Revoke ${token.name}`}
                  onClick={() => {
                    onRevoke(token);
                  }}
                >
                  Revoke
                </Button>
              )}
            </div>
            <ul
              aria-label={`What ${token.name} may do`}
              className="flex flex-wrap gap-1.5"
            >
              {token.scopes.map((scope) => (
                <li
                  key={scope}
                  title={SCOPE_COPY[scope].description}
                  className="rounded-md border border-surface-ink/7 bg-surface-ink/[0.03] px-2 py-0.5 text-xs text-muted-foreground"
                >
                  {SCOPE_COPY[scope].label}
                </li>
              ))}
            </ul>
            <Lifetime token={token} nowMs={nowMs} />
            {token.status !== 'membership_changed' ? null : (
              <p className="text-xs leading-relaxed text-muted-foreground">
                Your membership changed after this token was created. Create a
                replacement with your current access.
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Created → today → expiry as one thread, with when it was last used. */
function Lifetime({
  token,
  nowMs,
}: Readonly<{ token: ApiTokenMetadata; nowMs: number }>) {
  const start = Date.parse(token.createdAt);
  const end = Date.parse(token.expiresAt);
  const share = Math.min(1, Math.max(0, (nowMs - start) / (end - start || 1)));
  const ended = token.status === 'revoked' || nowMs >= end;
  const closing = !ended && end - nowMs < 7 * 86_400_000;
  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <div
        aria-hidden="true"
        className="relative h-1 rounded-full bg-surface-ink/[0.07]"
      >
        <span
          className={cn(
            'absolute inset-y-0 left-0 rounded-full',
            lifetimeClass({ ended, closing }),
          )}
          style={{ width: `${String(share * 100)}%` }}
        />
        {ended ? null : (
          <span
            className="absolute top-1/2 size-2 -translate-1/2 rounded-full bg-foreground"
            style={{ left: `${String(share * 100)}%` }}
          />
        )}
      </div>
      {/* Each phrase is one element, so it reads (and matches) whole. */}
      <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-muted-foreground">
        <TokenEnd token={token} end={end} nowMs={nowMs} />
        {token.lastUsedAt === null ? (
          <span>Not used yet</span>
        ) : (
          <time
            dateTime={token.lastUsedAt}
            title={formatDateTime(token.lastUsedAt)}
          >
            {`Last used ${formatRelativeTime(token.lastUsedAt, nowMs)}`}
          </time>
        )}
      </div>
    </div>
  );
}

function lifetimeClass({
  ended,
  closing,
}: Readonly<{ ended: boolean; closing: boolean }>): string {
  if (ended) return 'bg-surface-ink/20';
  return closing ? 'bg-warning' : 'bg-action/70';
}

function TokenEnd({
  token,
  end,
  nowMs,
}: Readonly<{ token: ApiTokenMetadata; end: number; nowMs: number }>) {
  if (token.status !== 'revoked')
    return (
      <time dateTime={token.expiresAt} title={formatDateTime(token.expiresAt)}>
        {`${nowMs >= end ? 'Expired' : 'Expires'} ${formatRelativeTime(token.expiresAt, nowMs)}`}
      </time>
    );
  return (
    <time dateTime={token.revokedAt} title={formatDateTime(token.revokedAt)}>
      {`Revoked ${formatRelativeTime(token.revokedAt, nowMs)}`}
    </time>
  );
}
