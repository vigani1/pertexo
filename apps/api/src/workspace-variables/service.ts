import {
  workspaceVariablesResponseSchema,
  workspaceVariablesCommandResponseSchema,
  workspaceVariableUsageResponseSchema,
  workspaceVariableUsageCursorSchema,
  type WorkspaceVariableUsageCursor,
} from '@pertexo/contracts';
import {
  WorkspaceVariablesConflictError,
  WorkspaceVariableUsageChangedError,
  WorkspaceAccessDeniedError,
  type WorkspaceVariablesStore,
} from '@pertexo/database/tenant-access';
import { IdempotencyConflictError } from '@pertexo/database/platform';
import {
  applicationError,
  throwApplicationError,
} from '../platform/http/index.js';
async function operation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof WorkspaceVariablesConflictError)
      return throwApplicationError(
        applicationError('variables.changed', {
          safeDetail:
            'Someone changed the workspace variables. Your edits are kept; reload the latest set before saving again.',
        }),
      );
    if (error instanceof WorkspaceVariableUsageChangedError)
      return throwApplicationError(
        applicationError('variables.usage_changed', {
          safeDetail:
            'A workflow changed during this reference check. Restart the check for current results.',
        }),
      );
    if (error instanceof WorkspaceAccessDeniedError)
      return throwApplicationError(applicationError('resource.not_found'));
    if (error instanceof IdempotencyConflictError)
      return throwApplicationError(
        applicationError('request.idempotency_conflict'),
      );
    throw error;
  }
}
export class WorkspaceVariablesService {
  constructor(private readonly store: WorkspaceVariablesStore) {}
  read(input: Parameters<WorkspaceVariablesStore['read']>[0]) {
    return operation(async () =>
      workspaceVariablesResponseSchema.parse(await this.store.read(input)),
    );
  }
  replace(input: Parameters<WorkspaceVariablesStore['replace']>[0]) {
    return operation(async () =>
      workspaceVariablesCommandResponseSchema.parse(
        await this.store.replace(input),
      ),
    );
  }
  usage(
    input: Omit<Parameters<WorkspaceVariablesStore['usage']>[0], 'after'> & {
      after?: string | undefined;
    },
  ) {
    let after: WorkspaceVariableUsageCursor | undefined;
    if (input.after !== undefined) {
      try {
        after = workspaceVariableUsageCursorSchema.parse(
          JSON.parse(
            Buffer.from(input.after, 'base64url').toString('utf8'),
          ) as unknown,
        );
      } catch {
        return throwApplicationError(
          applicationError('request.invalid', {
            safeDetail: 'Reference cursor is invalid. Restart this check.',
          }),
        );
      }
    }
    const { after: _encoded, ...scope } = input;
    return operation(async () => {
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
            : Buffer.from(JSON.stringify(result.next)).toString('base64url'),
      });
    });
  }
}
