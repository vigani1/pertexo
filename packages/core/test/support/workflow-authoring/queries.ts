import { ownerPool } from './base.js';

export async function executeAsOwner(
  statement: string,
  parameters: readonly unknown[] = [],
): Promise<void> {
  const client = await ownerPool.connect();
  let rollbackFailure: unknown;
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    await client.query(statement, [...parameters]);
    await client.query('commit');
  } catch (error: unknown) {
    try {
      await client.query('rollback');
    } catch (rollbackError: unknown) {
      rollbackFailure = rollbackError;
    }
    throw error;
  } finally {
    client.release(
      rollbackFailure === undefined
        ? undefined
        : new Error('Owner fixture rollback failed', {
            cause: rollbackFailure,
          }),
    );
  }
}

export async function queryAsOwner<T extends Record<string, unknown>>(
  statement: string,
  parameters: readonly unknown[] = [],
  scopedWorkspaceId?: string,
): Promise<readonly T[]> {
  const client = await ownerPool.connect();
  let rollbackFailure: unknown;
  try {
    await client.query('begin');
    await client.query('set local role pertexo_owner');
    if (scopedWorkspaceId !== undefined) {
      await client.query("select set_config('app.workspace_id', $1, true)", [
        scopedWorkspaceId,
      ]);
    }
    const result = await client.query<T>(statement, [...parameters]);
    await client.query('commit');
    return result.rows;
  } catch (error: unknown) {
    try {
      await client.query('rollback');
    } catch (rollbackError: unknown) {
      rollbackFailure = rollbackError;
    }
    throw error;
  } finally {
    client.release(
      rollbackFailure === undefined
        ? undefined
        : new Error('Owner fixture rollback failed', {
            cause: rollbackFailure,
          }),
    );
  }
}
