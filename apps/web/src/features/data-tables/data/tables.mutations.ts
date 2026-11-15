import { useQueryClient } from '@tanstack/react-query';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import {
  sendTableCommand,
  type TableCommand,
  type TableScope,
} from './tables.api';
import { tableKeys } from './tables.queries';

type TableCommandResult = Awaited<ReturnType<typeof sendTableCommand>>;

/**
 * One data-table command with its retained idempotency key. Every table view
 * refetches once it lands; then `onDone` runs (close the dialog, open the new
 * table).
 */
export function useTableCommand<Body>(
  scope: TableScope,
  toCommand: (body: Body) => TableCommand,
  options: Readonly<{
    action: string;
    onDone?: (result: TableCommandResult) => void;
  }>,
) {
  const cache = useQueryClient();
  return useRetainedCommand(
    (body: Body, key: string) => sendTableCommand(scope, toCommand(body), key),
    async (result) => {
      await cache.invalidateQueries({ queryKey: tableKeys.scope(scope) });
      options.onDone?.(result);
    },
    { action: options.action },
  );
}
