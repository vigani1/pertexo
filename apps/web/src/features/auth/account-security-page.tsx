import type { UserProfileResponse } from '@pertexo/contracts/schemas/identity-workspace';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { ShieldCheckIcon } from 'lucide-react';
import { AuroraLoadingPanel } from '@/components/patterns/aurora-loading-panel';
import {
  GlassSection,
  GlassSectionContent,
  GlassSectionDescription,
  GlassSectionHeader,
  GlassSectionTitle,
} from '@/components/patterns/glass-section';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/api-error';
import {
  useRevokeAccountSession,
  useRevokeOtherAccountSessions,
} from './account-security.mutations';
import {
  accountSecurityQueryOptions,
  accountSecuritySessionsQueryOptions,
} from './account-security.queries';
import { AccountPasswordSection } from './components/account-password-section';
import { AccountMethodsSection } from './components/account-methods-section';
import { AccountEmailSection } from './components/account-email-section';

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function AccountSecurityPage({
  apiClient,
  user,
  linkOutcome,
}: Readonly<{
  apiClient: ApiClient;
  user: UserProfileResponse;
  linkOutcome?: 'returned' | 'failed';
}>) {
  const [sessionToEnd, setSessionToEnd] = useState<
    { kind: 'one'; id: string; label: string } | { kind: 'others' } | undefined
  >();
  const security = useQuery(accountSecurityQueryOptions(apiClient, user.id));
  const sessions = useQuery(
    accountSecuritySessionsQueryOptions(apiClient, user.id),
  );
  const revoke = useRevokeAccountSession(apiClient, user.id);
  const revokeOthers = useRevokeOtherAccountSessions(apiClient, user.id);
  const pending =
    security.isPending ||
    sessions.isPending ||
    revoke.isPending ||
    revokeOthers.isPending;
  const otherSessions =
    sessions.data?.items.filter((session) => !session.current) ?? [];
  const mutationError = revoke.error ?? revokeOthers.error;

  return (
    <main id="main" className="app-stage min-h-svh px-5 py-8 sm:px-8 sm:py-12">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-7">
        <header className="flex flex-col gap-4 border-b border-white/8 pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <ShieldCheckIcon
                aria-hidden="true"
                className="size-7 text-primary"
              />
              <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
                Account security
              </h1>
            </div>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              Review browser sessions for {user.email}. Session identifiers
              shown here cannot authenticate a request.
            </p>
          </div>
          <Link
            to="/workspaces"
            className="text-sm font-medium text-primary hover:underline"
          >
            Back to workspaces
          </Link>
        </header>

        {linkOutcome === 'returned' ? (
          <p role="status" className="text-sm text-primary">
            Provider verification returned. Review the methods below to confirm
            the new connection.
          </p>
        ) : linkOutcome === 'failed' ? (
          <p role="alert" className="text-sm text-destructive">
            Linking did not complete. Your existing methods remain available.
            Review them below; adding a provider may be unavailable right now.
          </p>
        ) : null}

        {security.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading authentication methods…
          </p>
        ) : security.isError ? (
          <GlassSection>
            <GlassSectionContent className="space-y-3">
              <p role="alert" className="text-sm text-destructive">
                {securityError(security.error)}
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => void security.refetch()}
              >
                Try again
              </Button>
            </GlassSectionContent>
          </GlassSection>
        ) : (
          <>
            <AccountMethodsSection
              apiClient={apiClient}
              userId={user.id}
              security={security.data}
            />
            <AccountPasswordSection
              apiClient={apiClient}
              userId={user.id}
              security={security.data}
            />
            <AccountEmailSection
              apiClient={apiClient}
              security={security.data}
            />
          </>
        )}

        <AuroraLoadingPanel active={pending}>
          <GlassSection aria-busy={pending}>
            <GlassSectionHeader>
              <GlassSectionTitle>Signed-in browsers</GlassSectionTitle>
              <GlassSectionDescription>
                Ending another session takes effect on its next authorized
                request.
              </GlassSectionDescription>
            </GlassSectionHeader>
            <GlassSectionContent className="space-y-5">
              {sessions.isPending ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Loading sessions…
                </p>
              ) : sessions.isError ? (
                <div className="space-y-3" role="alert">
                  <p className="text-sm text-destructive">
                    {securityError(sessions.error)}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void sessions.refetch()}
                  >
                    Try again
                  </Button>
                </div>
              ) : (
                <>
                  <ul
                    className="divide-y divide-border"
                    aria-label="Signed-in browser sessions"
                  >
                    {sessions.data.items.map((session) => (
                      <li
                        key={session.id}
                        className="flex flex-col justify-between gap-4 py-4 sm:flex-row sm:items-center"
                      >
                        <div className="min-w-0">
                          <p className="font-medium">
                            {session.current
                              ? 'This browser'
                              : (session.userAgent ?? 'Unidentified browser')}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Last active{' '}
                            {dateFormatter.format(new Date(session.updatedAt))}{' '}
                            · Expires{' '}
                            {dateFormatter.format(new Date(session.expiresAt))}
                          </p>
                          {session.ipAddress === null ? null : (
                            <p className="mt-1 font-mono text-xs text-muted-foreground">
                              {session.ipAddress}
                            </p>
                          )}
                        </div>
                        {session.current ? (
                          <span className="text-xs text-primary">Current</span>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={
                              revoke.isPending || revokeOthers.isPending
                            }
                            onClick={() => {
                              revoke.reset();
                              setSessionToEnd({
                                kind: 'one',
                                id: session.id,
                                label: session.userAgent ?? 'this browser',
                              });
                            }}
                          >
                            End session
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                  {otherSessions.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No other active browser sessions.
                    </p>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={revoke.isPending || revokeOthers.isPending}
                      onClick={() => {
                        revokeOthers.reset();
                        setSessionToEnd({ kind: 'others' });
                      }}
                    >
                      {revokeOthers.isPending
                        ? 'Ending sessions…'
                        : 'End all other sessions'}
                    </Button>
                  )}
                </>
              )}
            </GlassSectionContent>
          </GlassSection>
        </AuroraLoadingPanel>
        <Dialog
          open={sessionToEnd !== undefined}
          onOpenChange={(open) => {
            if (!open && !revoke.isPending && !revokeOthers.isPending) {
              revoke.reset();
              revokeOthers.reset();
              setSessionToEnd(undefined);
            }
          }}
        >
          <DialogContent>
            <DialogTitle>End browser session?</DialogTitle>
            <DialogDescription>
              {sessionToEnd?.kind === 'one'
                ? `End ${sessionToEnd.label}? That browser must sign in again.`
                : 'End every other browser session? Those browsers must sign in again.'}
            </DialogDescription>
            {mutationError === null ? null : (
              <p role="alert" className="mt-4 text-sm text-destructive">
                {securityError(mutationError)}
              </p>
            )}
            <div className="mt-6 flex justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                disabled={revoke.isPending || revokeOthers.isPending}
                onClick={() => {
                  revoke.reset();
                  revokeOthers.reset();
                  setSessionToEnd(undefined);
                }}
              >
                Keep sessions
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={
                  sessionToEnd === undefined ||
                  revoke.isPending ||
                  revokeOthers.isPending
                }
                onClick={() => {
                  if (sessionToEnd?.kind === 'one')
                    revoke.mutate(sessionToEnd.id, {
                      onSuccess: () => {
                        setSessionToEnd(undefined);
                      },
                    });
                  if (sessionToEnd?.kind === 'others')
                    revokeOthers.mutate(undefined, {
                      onSuccess: () => {
                        setSessionToEnd(undefined);
                      },
                    });
                }}
              >
                {revoke.isPending || revokeOthers.isPending
                  ? 'Ending…'
                  : 'End sessions'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </main>
  );
}

function securityError(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 401)
      return 'Your session expired. Sign in again to manage account security.';
    if (error.status === 403)
      return 'This security change requires a recent sign-in. Sign out and sign in again, then retry.';
    if (error.kind === 'network')
      return 'Account security could not be reached. Check your connection and try again.';
  }
  return 'Account security could not be updated. Try again.';
}
