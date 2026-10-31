import type { ReactNode } from 'react';
import type { ConnectionResponse } from '@pertexo/contracts';
import { CopyButton } from '@/components/ui/copy-button';
import { formatDateTime, formatRelativeTime } from '@/lib/format/time';
import { credentialWord, PROVIDERS } from '../../model/connection-providers';
import { grantSentence, shownHost } from '../../model/oauth2-copy';
import { Disclosure } from '@/components/ui/disclosure';

function shortId(id: string): string {
  return `${id.slice(0, 4)}…${id.slice(-3)}`;
}

function Fact({
  term,
  children,
}: Readonly<{ term: string; children: ReactNode }>) {
  return (
    <>
      <dt className="text-subtle-foreground">{term}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function IdentifierFact({
  term,
  value,
  copyLabel,
}: Readonly<{ term: string; value: string; copyLabel: string }>) {
  return (
    <Fact term={term}>
      <CopyButton value={value} label={copyLabel} display={shortId(value)} />
    </Fact>
  );
}

function testedWhen(value: string | null | undefined): string {
  return value == null
    ? 'Never'
    : `${formatRelativeTime(value)} · ${formatDateTime(value)}`;
}

/** What Pertexo knows about a connection, without any of its secret. */
export function ConnectionFacts({
  connection,
}: Readonly<{ connection: ConnectionResponse }>) {
  const provider = PROVIDERS[connection.providerKey];
  const { health } = connection;
  const word = credentialWord(connection.providerKey, connection.authType);
  const credentialLabel = `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
  // With no history at all the status line already says "never tested";
  // once a run has reported, "Last tested: Never" is the useful contrast.
  const anyHistory = [
    health.lastTestedAt,
    health.lastHealthyAt,
    health.lastRunObservedAt,
    health.lastHealthTransitionAt,
  ].some((value) => value != null);
  const edited =
    Date.parse(connection.updatedAt) - Date.parse(connection.createdAt) >=
    60_000;
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm">
        <Fact term="Service">{provider.name}</Fact>
        <Fact term="Credential">{credentialLabel}, stored encrypted</Fact>
        {connection.authType === 'oauth2' ? (
          <>
            <Fact term="Token address">
              {shownHost(connection.oauth2.settings.tokenUrl)}
            </Fact>
            <Fact term="Client ID">
              <span className="break-all">
                {connection.oauth2.settings.clientId}
              </span>
            </Fact>
            {connection.status === 'active' ? (
              <Fact term="Token">
                {grantSentence(connection.grant, formatDateTime)}
              </Fact>
            ) : null}
          </>
        ) : null}
        <Fact term="Works with">{provider.usedBy}</Fact>
        {anyHistory ? (
          <Fact term="Last tested">{testedWhen(health.lastTestedAt)}</Fact>
        ) : null}
        {health.lastHealthyAt == null ? null : (
          <Fact term="Last healthy">{testedWhen(health.lastHealthyAt)}</Fact>
        )}
        {health.lastRunObservedAt == null ? null : (
          <Fact term="Used by a run">
            {testedWhen(health.lastRunObservedAt)}
          </Fact>
        )}
        {health.lastHealthTransitionAt == null ? null : (
          <Fact term="Health changed">
            {testedWhen(health.lastHealthTransitionAt)}
            {health.lastHealthTransitionSource == null ? null : (
              <span className="block text-xs text-muted-foreground">
                {
                  {
                    run: 'From a workflow run',
                    test: 'From an explicit test',
                    rotation: 'Credential replaced',
                    revoke: 'Connection revoked',
                  }[health.lastHealthTransitionSource]
                }
              </span>
            )}
          </Fact>
        )}
        <Fact term="Added">{formatDateTime(connection.createdAt)}</Fact>
        {edited ? (
          <Fact term="Updated">{formatDateTime(connection.updatedAt)}</Fact>
        ) : null}
      </dl>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {connection.providerKey === 'slack'
          ? 'Runs that send Slack messages keep its health up to date. '
          : 'Test it to check it still works. '}
        A failed test means Pertexo couldn’t use this credential, not that the
        service is down.
      </p>
      <Disclosure summary="Details">
        <dl className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5">
          <IdentifierFact
            term="Connection ID"
            value={connection.id}
            copyLabel="Copy connection ID"
          />
          <IdentifierFact
            term="Secret version"
            value={connection.secretVersionId}
            copyLabel="Copy secret version"
          />
        </dl>
      </Disclosure>
    </div>
  );
}
