import type { ReactNode } from 'react';
import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import { ChevronRightIcon } from 'lucide-react';
import { CopyButton } from '@/components/ui/copy-button';
import { formatDateTime, formatRelativeTime } from '@/lib/format-time';
import { PROVIDERS } from '../../model/connection-providers';

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

function testedWhen(value: string | null): string {
  return value === null
    ? 'Never'
    : `${formatRelativeTime(value)} · ${formatDateTime(value)}`;
}

/** What Pertexo knows about a connection, without any of its secret. */
export function ConnectionFacts({
  connection,
}: Readonly<{ connection: ConnectionResponse }>) {
  const provider = PROVIDERS[connection.providerKey];
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm">
        <Fact term="Service">{provider.name}</Fact>
        <Fact term="Credential">
          {provider.credential.charAt(0).toUpperCase()}
          {provider.credential.slice(1)}, stored encrypted
        </Fact>
        <Fact term="Works with">{provider.usedBy}</Fact>
        <Fact term="Last tested">
          {testedWhen(connection.health.lastTestedAt)}
        </Fact>
        <Fact term="Last healthy">
          {testedWhen(connection.health.lastHealthyAt)}
        </Fact>
        <Fact term="Added">{formatDateTime(connection.createdAt)}</Fact>
        <Fact term="Updated">{formatDateTime(connection.updatedAt)}</Fact>
      </dl>
      <details className="group/details text-sm">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-subtle-foreground outline-none select-none hover:text-foreground focus-visible:text-foreground [&::-webkit-details-marker]:hidden">
          <ChevronRightIcon
            aria-hidden="true"
            className="size-3.5 transition-transform group-open/details:rotate-90"
          />
          Details
        </summary>
        <dl className="mt-3 grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5">
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
      </details>
    </div>
  );
}
