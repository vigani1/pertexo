import { Link } from '@tanstack/react-router';
import type {
  DataTablesResponse,
  DataTableDefinition,
} from '@pertexo/contracts';
import { EllipsisIcon } from 'lucide-react';
import {
  Empty,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from '@/components/ui/empty';
import { LooseThread } from '@/components/patterns/states/thread-illustrations';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatByteLength } from '@/lib/format/bytes';
import { FORMAT_LOCALE } from '@/lib/format/locale';
import { ColumnChip, TableSwatch, UsageMeter } from './column-type';
export function TablePageActions({
  detail,
  editable,
  admin,
  table,
  onDialog,
}: Readonly<{
  detail: boolean;
  editable: boolean;
  admin: boolean;
  table: DataTableDefinition | undefined;
  onDialog: (dialog: 'create' | 'limits' | 'remove' | 'columns') => void;
}>) {
  // One table's page keeps to that table; workspace limits live on the list.
  if (detail)
    return table === undefined || !editable ? null : (
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            onDialog('columns');
          }}
        >
          Edit columns
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="More table actions"
              />
            }
          >
            <EllipsisIcon aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              variant="destructive"
              onClick={() => {
                onDialog('remove');
              }}
            >
              Delete table
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  return (
    <div className="flex flex-wrap gap-2">
      {editable ? (
        <Button
          type="button"
          variant="primary"
          onClick={() => {
            onDialog('create');
          }}
        >
          New table
        </Button>
      ) : null}
      {admin ? (
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            onDialog('limits');
          }}
        >
          Table limits
        </Button>
      ) : null}
    </div>
  );
}
/**
 * The workspace's table capacity as two meters under the title: how many
 * tables of the limit, and how much of the storage they share.
 */
export function TableCapacity({
  quotas,
}: Readonly<{ quotas: DataTablesResponse['quotas'] | undefined }>) {
  if (quotas === undefined) return null;
  return (
    <div className="grid max-w-xl grid-cols-1 min-[400px]:grid-cols-2 gap-6 text-sm">
      <div className="flex flex-col gap-1.5">
        <p className="flex items-baseline justify-between gap-2">
          <span className="text-muted-foreground">Tables</span>
          <span className="font-mono text-xs whitespace-nowrap tabular-nums">
            {quotas.tableCount} / {quotas.tableLimit}
          </span>
        </p>
        <UsageMeter
          used={quotas.tableCount}
          limit={quotas.tableLimit}
          label="Tables used"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="flex items-baseline justify-between gap-2">
          <span className="text-muted-foreground">Storage</span>
          <span className="font-mono text-xs whitespace-nowrap tabular-nums">
            {formatByteLength(quotas.storedBytes)} /{' '}
            {formatByteLength(quotas.byteLimit)}
          </span>
        </p>
        <UsageMeter
          used={quotas.storedBytes}
          limit={quotas.byteLimit}
          label="Table storage used"
        />
      </div>
    </div>
  );
}

// Chips a card shows before folding the rest into "+N".
const SHOWN_COLUMNS = 4;

/**
 * Every table as a card: its woven swatch, its name and key, its columns as
 * typed chips, and how many rows it holds of the limit.
 */
export function TableCollection({
  tables,
  rowLimit,
  workspaceId,
}: Readonly<{
  tables: DataTablesResponse['tables'] | undefined;
  rowLimit: number | undefined;
  workspaceId: string;
}>) {
  if (tables?.length === 0)
    return (
      <Empty>
        <EmptyMedia className="w-full max-w-56">
          <LooseThread />
        </EmptyMedia>
        <EmptyTitle>No tables yet</EmptyTitle>
        <EmptyDescription>
          Create a table to keep orders, reference values or workflow state
          here.
        </EmptyDescription>
      </Empty>
    );
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {tables?.map((item) => {
        const more = item.columns.length - SHOWN_COLUMNS;
        return (
          <li key={item.id} className="min-w-0">
            <Link
              to="/w/$workspaceId/data-tables/$tableId"
              params={{ workspaceId, tableId: item.id }}
              className="group flex h-full min-w-0 flex-col gap-4 rounded-xl border border-surface-ink/7 bg-surface-ink/[0.02] p-4 outline-none transition-colors duration-150 hover:border-surface-ink/14 hover:bg-surface-ink/[0.04] focus-ring motion-reduce:transition-none"
            >
              <div className="flex min-w-0 items-center gap-3">
                <TableSwatch columns={item.columns} rowCount={item.rowCount} />
                <div className="min-w-0">
                  <p className="wrap-anywhere font-medium group-hover:text-accent-foreground">
                    {item.name}
                  </p>
                  <p className="text-xs text-subtle-foreground">
                    {item.columns.length}{' '}
                    {item.columns.length === 1 ? 'column' : 'columns'}
                    {item.keyColumn === null ? '' : ' · unique key'}
                  </p>
                </div>
              </div>
              <div className="flex min-w-0 flex-wrap gap-1.5">
                {item.columns.slice(0, SHOWN_COLUMNS).map((column) => (
                  <ColumnChip
                    key={column.name}
                    column={column}
                    isKey={column.name === item.keyColumn}
                  />
                ))}
                {more > 0 ? (
                  <span className="self-center font-mono text-[0.7rem] text-subtle-foreground">
                    +{more}
                  </span>
                ) : null}
              </div>
              <div className="mt-auto flex flex-col gap-1.5">
                <p className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="font-mono tabular-nums">
                    {item.rowCount.toLocaleString(FORMAT_LOCALE)}{' '}
                    <span className="font-sans text-muted-foreground">
                      {item.rowCount === 1 ? 'row' : 'rows'}
                    </span>
                  </span>
                  <span className="font-mono text-xs text-subtle-foreground">
                    {formatByteLength(item.storedBytes)}
                  </span>
                </p>
                {rowLimit === undefined ? null : (
                  <UsageMeter
                    used={item.rowCount}
                    limit={rowLimit}
                    label={`${item.name} rows used`}
                  />
                )}
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
