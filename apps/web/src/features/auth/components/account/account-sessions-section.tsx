import type { AccountSecuritySessionsResponse } from '@pertexo/contracts/schemas/identity-workspace';
import { useQuery } from '@tanstack/react-query';
import { LaptopIcon, SmartphoneIcon } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import { Button } from '@/components/ui/button';
import type { ApiClient } from '@/lib/api/client';
import { formatDateTime, formatRelativeTime } from '@/lib/format-time';
import { accountSecuritySessionsQueryOptions } from '../../account-security.queries';
import {
  accountCommandFailure,
  accountReadFailure,
} from '../../model/account-failure';
import { orderSessions } from '../../model/sessions';
import { describeUserAgent } from '../../model/user-agent';
import {
  AccountReadFailure,
  AccountRowsPending,
  AccountSection,
  FreshSignInLink,
} from './account-section';
import { useSessionEnding, type SessionEnding } from './use-session-ending';

type Session = AccountSecuritySessionsResponse['items'][number];

const MOBILE = /\b(?:iPhone|iPad|Android|Mobile)\b/u;
/** Sessions shown before "Show all": this device and the latest others. */
const SHOWN_SESSIONS = 6;

function SessionRow({
  session,
  busy,
  onEnd,
}: Readonly<{ session: Session; busy: boolean; onEnd: () => void }>) {
  const label = describeUserAgent(session.userAgent);
  const Icon = MOBILE.test(session.userAgent ?? '')
    ? SmartphoneIcon
    : LaptopIcon;
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md border border-white/10 bg-white/[0.035] text-muted-foreground">
          <Icon aria-hidden="true" className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            {label}
            {session.current ? (
              <Badge variant="default">This device</Badge>
            ) : null}
          </p>
          <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            <span title={formatDateTime(session.updatedAt)}>
              {session.current
                ? 'Active now'
                : `Last active ${formatRelativeTime(session.updatedAt)}`}
            </span>
            <span title={formatDateTime(session.createdAt)}>
              Signed in {formatRelativeTime(session.createdAt)}
            </span>
            {session.ipAddress === null ? null : (
              <span className="font-mono">{session.ipAddress}</span>
            )}
          </p>
        </div>
      </div>
      {session.current ? null : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={`Sign out ${label}`}
          disabled={busy}
          onClick={onEnd}
        >
          Sign out
        </Button>
      )}
    </li>
  );
}

/** The signed-in devices, this one first, with "Show all" past the latest. */
function SessionList({
  items,
  busy,
  onEnd,
}: Readonly<{
  items: readonly Session[];
  busy: boolean;
  onEnd: (ending: SessionEnding) => void;
}>) {
  const [showAll, setShowAll] = useState(false);
  const hasOthers = items.some((session) => !session.current);
  return (
    <>
      <ul
        aria-label="Signed-in devices"
        className="divide-y divide-border rounded-lg border border-border"
      >
        {orderSessions(items)
          .slice(0, showAll ? undefined : SHOWN_SESSIONS)
          .map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              busy={busy}
              onEnd={() => {
                onEnd({
                  kind: 'one',
                  id: session.id,
                  label: describeUserAgent(session.userAgent),
                });
              }}
            />
          ))}
      </ul>
      {!showAll && items.length > SHOWN_SESSIONS ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => {
            setShowAll(true);
          }}
        >
          Show all {items.length} sessions
        </Button>
      ) : null}
      {hasOthers ? null : (
        <p className="text-sm text-muted-foreground">
          No other devices are signed in.
        </p>
      )}
    </>
  );
}

/** Confirms signing out one device or every other one. */
function EndSessionDialog({
  ending,
  busy,
  error,
  onCancel,
  onConfirm,
}: Readonly<{
  ending: SessionEnding | undefined;
  busy: boolean;
  error: unknown;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}>) {
  return (
    <ConfirmDialog
      open={ending !== undefined}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={
        ending?.kind === 'others'
          ? 'Sign out all other devices?'
          : 'Sign out this device?'
      }
      description={
        ending?.kind === 'one'
          ? `${ending.label} will need to sign in again.`
          : 'Every other browser and device will need to sign in again. This one stays signed in.'
      }
      tone="destructive"
      confirmLabel="Sign out"
      pendingLabel="Signing out…"
      pending={busy}
      error={
        error === null ? undefined : accountCommandFailure(error, 'signing out')
      }
      errorAction={<FreshSignInLink error={error} />}
      onConfirm={onConfirm}
    />
  );
}

/** Where this account is signed in, with sign-out for one or all others. */
export function AccountSessionsSection({
  apiClient,
  userId,
}: Readonly<{ apiClient: ApiClient; userId: string }>) {
  const sessions = useQuery(
    accountSecuritySessionsQueryOptions(apiClient, userId),
  );
  const ending = useSessionEnding(apiClient, userId);
  const hasOthers =
    sessions.data?.items.some((session) => !session.current) ?? false;

  return (
    <AccountSection
      title="Sessions"
      description="Signing out a device takes effect the next time it talks to Pertexo."
      action={
        hasOthers ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={ending.busy}
            onClick={() => {
              ending.ask({ kind: 'others' });
            }}
          >
            Sign out all other devices
          </Button>
        ) : undefined
      }
    >
      {sessions.isPending ? (
        <AccountRowsPending label="Loading your sessions…" />
      ) : sessions.isError ? (
        <AccountReadFailure
          message={accountReadFailure(sessions.error, 'sessions')}
          retrying={sessions.isFetching}
          onRetry={() => void sessions.refetch()}
        />
      ) : (
        <SessionList
          items={sessions.data.items}
          busy={ending.busy}
          onEnd={ending.ask}
        />
      )}
      <EndSessionDialog
        ending={ending.ending}
        busy={ending.busy}
        error={ending.error}
        onCancel={ending.cancel}
        onConfirm={ending.confirm}
      />
    </AccountSection>
  );
}
