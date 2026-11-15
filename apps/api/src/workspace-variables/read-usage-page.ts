import { workspaceVariableUsageCursorSchema } from '@pertexo/contracts';
import type {
  VariableUsageInput,
  WorkspaceVariablesStore,
} from '@pertexo/core/variables';

import {
  applicationError,
  throwApplicationError,
} from '../platform/http/index.js';
import {
  decodeOpaqueCursor,
  encodeOpaqueCursor,
} from '../platform/http/opaque-cursor.js';

/** A page of variable usage, with HTTP's opaque cursor in place of the store's. */
export async function readUsagePage(
  store: Pick<WorkspaceVariablesStore, 'usage'>,
  {
    after,
    ...scope
  }: Omit<VariableUsageInput, 'after'> & { after?: string | undefined },
) {
  const result = await store.usage({
    ...scope,
    ...(after === undefined ? {} : { after: decodeContinuation(after) }),
  });
  return {
    items: result.items,
    incomplete: result.incomplete,
    nextCursor:
      result.next === null
        ? null
        : encodeOpaqueCursor(workspaceVariableUsageCursorSchema, result.next),
  };
}

function decodeContinuation(after: string) {
  const cursor = decodeOpaqueCursor(workspaceVariableUsageCursorSchema, after);
  if (cursor !== undefined) return cursor;
  return throwApplicationError(
    applicationError('request.invalid', {
      safeDetail: 'Reference cursor is invalid. Restart this check.',
    }),
  );
}
