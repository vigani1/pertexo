import type { ConnectionResponse } from '@pertexo/contracts/schemas/connections';
import { Badge } from '@/components/ui/badge';
import type { ApiClient } from '@/lib/api/client';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ConnectionActions } from './connection-actions';

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const providerLabels: Record<ConnectionResponse['providerKey'], string> = {
  http: 'HTTP',
  slack: 'Slack',
  email: 'Email',
};

function statusVariant(
  status: ConnectionResponse['status'],
): 'default' | 'muted' | 'destructive' {
  if (status === 'active') return 'default';
  if (status === 'revoked') return 'destructive';
  return 'muted';
}

export function ConnectionTable({
  connections,
  apiClient,
  userId,
  workspaceId,
  canTest,
  canManage,
}: Readonly<{
  connections: readonly ConnectionResponse[];
  apiClient: ApiClient;
  userId: string;
  workspaceId: string;
  canTest: boolean;
  canManage: boolean;
}>) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Provider</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Last tested</TableHead>
          <TableHead>Updated</TableHead>
          {canTest || canManage ? (
            <TableHead className="text-right">Actions</TableHead>
          ) : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {connections.map((connection) => (
          <TableRow key={connection.id}>
            <TableCell>
              <div className="min-w-44">
                <p className="font-medium">{connection.name}</p>
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  {connection.authType.replaceAll('_', ' ')}
                </p>
              </div>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {providerLabels[connection.providerKey]}
            </TableCell>
            <TableCell>
              <Badge variant={statusVariant(connection.status)}>
                {connection.status.replaceAll('_', ' ')}
              </Badge>
            </TableCell>
            <TableCell className="whitespace-nowrap text-muted-foreground">
              {connection.health.lastTestedAt === null
                ? 'Not tested'
                : dateFormatter.format(
                    new Date(connection.health.lastTestedAt),
                  )}
            </TableCell>
            <TableCell className="whitespace-nowrap text-muted-foreground">
              {dateFormatter.format(new Date(connection.updatedAt))}
            </TableCell>
            {canTest || canManage ? (
              <TableCell>
                <ConnectionActions
                  apiClient={apiClient}
                  connection={connection}
                  userId={userId}
                  workspaceId={workspaceId}
                  canTest={canTest}
                  canManage={canManage}
                />
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
