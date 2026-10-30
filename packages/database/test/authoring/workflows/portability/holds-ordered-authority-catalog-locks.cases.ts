import { expect, it } from 'vitest';

import {
  actorId,
  workspaceId,
  apiUrl,
  migrationUrl,
  holdAtWrite,
  importWrite,
  randomUUID,
  queryAsOwner,
  WorkflowNotFoundError,
  Pool,
  waitForOperationEntry,
  waitForPostgresLock,
  withApplicationName,
  finishControlledScenario,
  finishTransactionClient,
} from '../../../support/workflow-authoring.js';
import { database, command } from './fixture.js';

export function registerHoldsOrderedAuthorityCatalogLocks(): void {
  it('holds ordered authority/catalog locks until import commits so later writers lose the race', async () => {
    for (const surface of ['workspace', 'actor', 'membership'] as const) {
      const input = command();
      const hold = await holdAtWrite(importWrite('workflow', input.name));
      const db = database();
      const application = `portable-${surface}-${randomUUID()}`;
      const pool = new Pool({
        connectionString: withApplicationName(migrationUrl, application),
        max: 1,
      });
      const owner = await pool.connect();
      let operation: Promise<unknown> | undefined,
        writer: Promise<unknown> | undefined,
        primaryError: unknown;
      try {
        operation = db.importWorkflow(input);
        await waitForOperationEntry(
          hold.reached(),
          operation,
          'portable admission',
        );
        await owner.query('begin');
        await owner.query('set local role pertexo_owner');
        await owner.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        const sql = {
          workspace: 'update app.workspaces set name=name where id=$1',
          actor: 'update app.users set display_name=display_name where id=$1',
          membership:
            'update app.workspace_memberships set role=role where workspace_id=$1 and user_id=$2',
        }[surface];
        let queryValues: string[];
        if (sql.includes('$2')) {
          queryValues = [workspaceId, actorId];
        } else {
          if (sql.includes('$1')) {
            queryValues = [surface === 'actor' ? actorId : workspaceId];
          } else {
            queryValues = [];
          }
        }
        writer = owner.query(sql, queryValues);
        await waitForPostgresLock(application);
        await hold.release();
        await expect(operation).resolves.toHaveProperty('workflowId');
        await writer;
        await owner.query('rollback');
      } catch (error) {
        primaryError = error;
      } finally {
        await hold.release();
        await Promise.allSettled(
          [operation, writer].filter((value) => value !== undefined),
        );
        await finishTransactionClient(owner, {
          label: 'portable writer',
          primaryError,
          transactionOpen: true,
        });
        await finishControlledScenario({
          label: 'portable race',
          primaryError,
          operations: [],
          release: () => void hold.release(),
          close: [() => pool.end(), () => hold.remove()],
        });
      }
    }
  });

  it('rechecks authority after a workspace/member writer wins and fences completed replay', async () => {
    const db = database();
    const input = command();
    await db.importWorkflow(input);
    await queryAsOwner(
      "update app.workspace_memberships set role='viewer' where workspace_id=$1 and user_id=$2",
      [workspaceId, actorId],
      workspaceId,
    );
    try {
      await expect(db.importWorkflow(input)).rejects.toBeInstanceOf(
        WorkflowNotFoundError,
      );
    } finally {
      await queryAsOwner(
        "update app.workspace_memberships set role='owner' where workspace_id=$1 and user_id=$2",
        [workspaceId, actorId],
        workspaceId,
      );
    }
  });

  it('lets a workspace-first membership writer invalidate a blocked new command', async () => {
    const application = `portable-member-first-${randomUUID()}`;
    const db = database({}, withApplicationName(apiUrl, application));
    const ownerPool = new Pool({ connectionString: migrationUrl, max: 1 });
    const owner = await ownerPool.connect();
    let pending: Promise<unknown> | undefined, primaryError: unknown;
    try {
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await owner.query(
        'select id from app.workspaces where id=$1 for update',
        [workspaceId],
      );
      await owner.query(
        "update app.workspace_memberships set role='viewer' where workspace_id=$1 and user_id=$2",
        [workspaceId, actorId],
      );
      pending = db.importWorkflow(command());
      const rejected = expect(pending).rejects.toBeInstanceOf(
        WorkflowNotFoundError,
      );
      await waitForPostgresLock(application);
      await owner.query('commit');
      await rejected;
    } catch (error) {
      primaryError = error;
    } finally {
      await finishTransactionClient(owner, {
        label: 'portable membership writer',
        primaryError,
        transactionOpen: true,
      });
      await Promise.allSettled(pending === undefined ? [] : [pending]);
      await queryAsOwner(
        "update app.workspace_memberships set role='owner' where workspace_id=$1 and user_id=$2",
        [workspaceId, actorId],
        workspaceId,
      );
      await ownerPool.end();
    }
  });
}
