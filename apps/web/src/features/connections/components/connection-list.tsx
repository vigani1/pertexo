import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import { ChevronRightIcon } from 'lucide-react';
import { Status } from '@/components/ui/status';
import { formatRelativeTime } from '@/lib/format-time';
import { cn } from '@/lib/utils';
import {
  describeConnectionHealth,
  describeConnectionStatus,
} from '../model/connection-health';
import { describeConnectionKind } from '../model/connection-providers';
import { ProviderTile } from './provider-tile';

function ConnectionRow({
  connection,
  onOpen,
}: Readonly<{
  connection: ConnectionResponse;
  onOpen: (connectionId: string) => void;
}>) {
  const status = describeConnectionStatus(connection.status);
  const health = describeConnectionHealth(connection);
  return (
    <li className="border-t border-border first:border-t-0">
      <button
        type="button"
        aria-label={`${connection.name}, ${status.label}, ${health.text}`}
        className="group/row grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3.5 gap-y-1 rounded-md px-2 py-3 text-left outline-none transition-colors hover:bg-card focus-visible:ring-2 focus-visible:ring-ring/60 sm:grid-cols-[auto_minmax(0,1fr)_7.5rem_minmax(0,13rem)_6rem_auto]"
        onClick={() => {
          onOpen(connection.id);
        }}
      >
        <ProviderTile provider={connection.providerKey} />
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">
            {connection.name}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {describeConnectionKind(connection.providerKey)}
          </span>
        </span>
        <Status tone={status.tone} className="max-sm:hidden">
          {status.label}
        </Status>
        <span
          className={cn(
            'col-start-2 truncate font-mono text-[0.72rem] sm:col-start-auto',
            health.tone === 'attention'
              ? 'text-warning'
              : 'text-subtle-foreground',
          )}
        >
          <span className="sm:hidden">{status.label} · </span>
          {health.text}
        </span>
        <span className="hidden font-mono text-[0.72rem] text-subtle-foreground sm:block">
          {formatRelativeTime(connection.updatedAt)}
        </span>
        <ChevronRightIcon
          aria-hidden="true"
          className="col-start-3 row-span-2 row-start-1 size-4 text-subtle-foreground transition-transform group-hover/row:translate-x-0.5 sm:col-start-auto sm:row-span-1 sm:row-start-auto"
        />
      </button>
    </li>
  );
}

export function ConnectionList({
  connections,
  onOpen,
}: Readonly<{
  connections: readonly ConnectionResponse[];
  onOpen: (connectionId: string) => void;
}>) {
  return (
    <ul aria-label="Connections" className="flex flex-col">
      {connections.map((connection) => (
        <ConnectionRow
          key={connection.id}
          connection={connection}
          onOpen={onOpen}
        />
      ))}
    </ul>
  );
}
