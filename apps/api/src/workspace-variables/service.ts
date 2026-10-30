import {
  workspaceVariablesResponseSchema,
  workspaceVariablesCommandResponseSchema,
  workspaceVariableUsageResponseSchema,
  workspaceVariableUsageCursorSchema,
  type WorkspaceVariableUsageCursor,
} from '@pertexo/contracts';
import type { WorkspaceVariablesStore } from '@pertexo/database/variables';

import {
  applicationError,
  throwApplicationError,
} from '../platform/http/index.js';
import {
  decodeOpaqueCursor,
  encodeOpaqueCursor,
} from '../platform/http/opaque-cursor.js';

export class WorkspaceVariablesService {
  constructor(private readonly store: WorkspaceVariablesStore) {}
  async read(input: Parameters<WorkspaceVariablesStore['read']>[0]) {
    return workspaceVariablesResponseSchema.parse(await this.store.read(input));
  }
  async replace(input: Parameters<WorkspaceVariablesStore['replace']>[0]) {
    return workspaceVariablesCommandResponseSchema.parse(
      await this.store.replace(input),
    );
  }
  async usage(
    input: Omit<Parameters<WorkspaceVariablesStore['usage']>[0], 'after'> & {
      after?: string | undefined;
    },
  ) {
    let after: WorkspaceVariableUsageCursor | undefined;
    if (input.after !== undefined) {
      after = decodeOpaqueCursor(
        workspaceVariableUsageCursorSchema,
        input.after,
      );
      if (after === undefined)
        return throwApplicationError(
          applicationError('request.invalid', {
            safeDetail: 'Reference cursor is invalid. Restart this check.',
          }),
        );
    }
    const { after: _encoded, ...scope } = input;
    const result = await this.store.usage({
      ...scope,
      ...(after === undefined ? {} : { after }),
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
