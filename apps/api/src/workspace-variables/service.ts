import {
  workspaceVariablesResponseSchema,
  workspaceVariablesCommandResponseSchema,
  workspaceVariableUsageResponseSchema,
  workspaceVariableUsageCursorSchema,
} from '@pertexo/contracts';
import type {
  ReplaceWorkspaceVariablesInput,
  VariableUsageInput,
  WorkspaceActor,
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

/** HTTP's view of the store: response checks and the opaque usage cursor. */
export class WorkspaceVariablesService {
  constructor(private readonly store: WorkspaceVariablesStore) {}
  async read(input: WorkspaceActor) {
    return workspaceVariablesResponseSchema.parse(await this.store.read(input));
  }
  async replace(input: ReplaceWorkspaceVariablesInput) {
    return workspaceVariablesCommandResponseSchema.parse(
      await this.store.replace(input),
    );
  }
  async usage({
    after,
    ...scope
  }: Omit<VariableUsageInput, 'after'> & { after?: string | undefined }) {
    const result = await this.store.usage({
      ...scope,
      ...(after === undefined ? {} : { after: decodeContinuation(after) }),
    });
    return workspaceVariableUsageResponseSchema.parse({
      items: result.items,
      incomplete: result.incomplete,
      nextCursor:
        result.next === null
          ? null
          : encodeOpaqueCursor(workspaceVariableUsageCursorSchema, result.next),
    });
  }
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
