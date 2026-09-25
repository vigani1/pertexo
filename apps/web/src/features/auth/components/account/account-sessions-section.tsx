import type { AccountSecuritySessionsResponse } from '@pertexo/contracts/schemas/identity-workspace';
import { useQuery } from '@tanstack/react-query';
import { LaptopIcon, SmartphoneIcon } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/patterns/confirm-dialog';
import { Button } from '@/components/ui/button';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import { formatDateTime, formatRelativeTime } from '@/lib/format-time';
import {
  useRevokeAccountSession,
  useRevokeOtherAccountSessions,
} from '../../account-security.mutations';
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

type Session = AccountSecuritySessionsResponse['items'][number];
type Ending =
  | Readonly<{ kind: 'one'; id: string; label: string }>
  | Readonly<{ kind: 'others' }>;

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

/** Where this account is signed in, with sign-out for one or all others. */
export function AccountSessionsSection({
  apiClient,
  userId,
}: Readonly<{ apiClient: ApiClient; userId: string }>) {
  const sessions = useQuery(
    accountSecuritySessionsQueryOptions(apiClient, userId),
  );
  const revoke = useRevokeAccountSession(apiClient, userId);
  const revokeOthers = useRevokeOtherAccountSessions(apiClient, userId);
  const notifications = useNotifications();
  const [ending, setEnding] = useState<Ending>();
  const [showAll, setShowAll] = useState(false);
  const busy = revoke.isPending || revokeOthers.isPending;
  const others =
    sessions.data?.items.filter((session) => !session.current) ?? [];
  const error = revoke.error ?? revokeOthers.error;

  function close() {
    if (busy) return;
    revoke.reset();
    revokeOthers.reset();
    setEnding(undefined);
  }

  async function confirm() {
    if (ending?.kind === 'one') {
      const { label } = ending;
      await revoke.mutateAsync(ending.id);
      setEnding(undefined);
      notifications.success({ title: `Signed out of ${label}` });
    }
    if (ending?.kind === 'others') {
      const result = await revokeOthers.mutateAsync();
      setEnding(undefined);
      notifications.success({
        title:
          result.revokedCount === 1
            ? 'Signed out of 1 other device'
            : `Signed out of ${String(result.revokedCount)} other devices`,
      });
    }
  }

  return (
    <AccountSection
      id="account-sessions-title"
      title="Sessions"
      description="Signing out a device takes effect the next time it talks to Pertexo."
      action={
        others.length === 0 ? undefined : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              revokeOthers.reset();
              setEnding({ kind: 'others' });
            }}
          >
            Sign out all other devices
          </Button>
        )
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
        <>
          <ul
            aria-label="Signed-in devices"
            className="divide-y divide-border rounded-lg border border-border"
          >
            {orderSessions(sessions.data.items)
              .slice(0, showAll ? undefined : SHOWN_SESSIONS)
              .map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  busy={busy}
                  onEnd={() => {
                    revoke.reset();
                    setEnding({
                      kind: 'one',
                      id: session.id,
                      label: describeUserAgent(session.userAgent),
                    });
                  }}
                />
              ))}
          </ul>
          {!showAll && sessions.data.items.length > SHOWN_SESSIONS ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() => {
                setShowAll(true);
              }}
            >
              Show all {sessions.data.items.length} sessions
            </Button>
          ) : null}
          {others.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No other devices are signed in.
            </p>
          ) : null}
        </>
      )}
      <ConfirmDialog
        open={ending !== undefined}
        onOpenChange={(open) => {
          if (!open) close();
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
          error === null
            ? undefined
            : accountCommandFailure(error, 'signing out')
        }
        errorAction={<FreshSignInLink error={error} />}
        onConfirm={confirm}
      />
    </AccountSection>
  );
}
