import type { AccountSecuritySessionsResponse } from '@pertexo/contracts/schemas/identity-workspace';
import { useQuery } from '@tanstack/react-query';
import { LaptopIcon, SmartphoneIcon } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { useNotifications } from '@/components/ui/use-notifications';
import type { ApiClient } from '@/lib/api/client';
import { formatDateTime, formatRelativeTime } from '@/lib/format-time';
import {
  useRevokeAccountSession,
  useRevokeOtherAccountSessions,
} from '../../account-security.mutations';
import { accountSecuritySessionsQueryOptions } from '../../account-security.queries';
import { ProgressButton } from '../../forms/progress-button';
import { accountReadFailure } from '../../model/account-failure';
import { describeUserAgent } from '../../model/user-agent';
import {
  AccountCommandFailure,
  AccountReadFailure,
  AccountRowsPending,
  AccountSection,
} from './account-section';

type Session = AccountSecuritySessionsResponse['items'][number];
type Ending =
  | Readonly<{ kind: 'one'; id: string; label: string }>
  | Readonly<{ kind: 'others' }>;

const MOBILE = /\b(?:iPhone|iPad|Android|Mobile)\b/u;

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

  function confirm() {
    if (ending?.kind === 'one') {
      const { label } = ending;
      revoke.mutate(ending.id, {
        onSuccess: () => {
          setEnding(undefined);
          notifications.success({ title: `Signed out of ${label}` });
        },
      });
    }
    if (ending?.kind === 'others')
      revokeOthers.mutate(undefined, {
        onSuccess: (result) => {
          setEnding(undefined);
          notifications.success({
            title:
              result.revokedCount === 1
                ? 'Signed out of 1 other device'
                : `Signed out of ${String(result.revokedCount)} other devices`,
          });
        },
      });
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
            {sessions.data.items.map((session) => (
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
          {others.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No other devices are signed in.
            </p>
          ) : null}
        </>
      )}
      <Dialog
        open={ending !== undefined}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogContent>
          <DialogTitle>
            {ending?.kind === 'others'
              ? 'Sign out all other devices?'
              : 'Sign out this device?'}
          </DialogTitle>
          <DialogDescription>
            {ending?.kind === 'one'
              ? `${ending.label} will need to sign in again.`
              : 'Every other browser and device will need to sign in again. This one stays signed in.'}
          </DialogDescription>
          {error === null ? null : (
            <AccountCommandFailure
              className="mt-4"
              error={error}
              action="signing out"
            />
          )}
          <div className="mt-6 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={close}
            >
              Cancel
            </Button>
            <ProgressButton
              type="button"
              variant="destructive"
              pending={busy}
              pendingLabel="Signing out…"
              onClick={confirm}
            >
              Sign out
            </ProgressButton>
          </div>
        </DialogContent>
      </Dialog>
    </AccountSection>
  );
}
