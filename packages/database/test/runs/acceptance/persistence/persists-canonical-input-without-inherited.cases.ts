import { count, eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { expect, it } from 'vitest';

import { acceptWorkflowRun } from '../../../../src/runs/commands/acceptance.repository.js';
import { IdempotencyRequestConflictError } from '../../../../src/runs/commands/acceptance/errors.js';
import {
  idempotencyRecords,
  outboxEvents,
  runCheckpoints,
  runEvents,
  workflowRuns,
} from '../../../../src/schema.js';
import {
  STORED_EXECUTION_VALUE_LIMITS,
  StoredExecutionValueInvalidError,
} from '../../../../src/platform/stored-execution-value.js';
import {
  acceptanceInput,
  apiDatabase,
  expectAcceptanceRecordCounts,
  migrationUrl,
  otherRequestHash,
  requestHash,
  workspaceA,
  workspaceCreatorId,
} from '../fixtures.js';

export function registerPersistsCanonicalInputWithoutInherited(): void {
  it('persists canonical input without inherited toJSON hooks', async () => {
    const objectDescriptor = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'toJSON',
    );
    const arrayDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      'toJSON',
    );
    let inputHookCalls = 0;
    try {
      Object.defineProperty(Object.prototype, 'toJSON', {
        configurable: true,
        value: function (this: unknown): unknown {
          if (
            typeof this === 'object' &&
            this !== null &&
            Object.hasOwn(this, 'kind') &&
            Object.hasOwn(this, 'value')
          )
            inputHookCalls += 1;
          return this;
        },
      });
      Object.defineProperty(Array.prototype, 'toJSON', {
        configurable: true,
        value: function (this: unknown): unknown {
          inputHookCalls += 1;
          return this;
        },
      });
      const accepted = await apiDatabase.withWorkspace(
        workspaceA,
        (transaction) =>
          acceptWorkflowRun(
            transaction,
            acceptanceInput(requestHash, { nested: [1, 2, 3] }),
          ),
      );
      await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
        await expect(
          db
            .select({ inputRef: workflowRuns.inputRef })
            .from(workflowRuns)
            .where(eq(workflowRuns.id, accepted.runId)),
        ).resolves.toEqual([
          {
            inputRef: {
              kind: 'inline',
              value: { nested: [1, 2, 3] },
            },
          },
        ]);
      });
      expect(inputHookCalls).toBe(0);
    } finally {
      if (objectDescriptor === undefined)
        Reflect.deleteProperty(Object.prototype, 'toJSON');
      else Object.defineProperty(Object.prototype, 'toJSON', objectDescriptor);
      if (arrayDescriptor === undefined)
        Reflect.deleteProperty(Array.prototype, 'toJSON');
      else Object.defineProperty(Array.prototype, 'toJSON', arrayDescriptor);
    }
  });

  it('rejects oversized or hostile run input before writing acceptance state', async () => {
    let getterCalls = 0;
    const hostile = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return true;
      },
    });
    for (const runInput of [
      'x'.repeat(STORED_EXECUTION_VALUE_LIMITS.inlineBytes - 1),
      hostile,
    ]) {
      await expect(
        apiDatabase.withWorkspace(workspaceA, (transaction) =>
          acceptWorkflowRun(
            transaction,
            acceptanceInput(requestHash, runInput),
          ),
        ),
      ).rejects.toBeInstanceOf(StoredExecutionValueInvalidError);
      await expectAcceptanceRecordCounts(0);
    }
    expect(getterCalls).toBe(0);
  });

  it('keeps the first durable run input on an exact idempotent replay', async () => {
    const first = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptWorkflowRun(
        transaction,
        acceptanceInput(requestHash, { retained: true }),
      ),
    );
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(
          transaction,
          acceptanceInput(requestHash, { retained: false }),
        ),
      ),
    ).resolves.toEqual({ ...first, duplicate: true });
    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      await expect(
        db
          .select({ inputRef: workflowRuns.inputRef })
          .from(workflowRuns)
          .where(eq(workflowRuns.id, first.runId)),
      ).resolves.toEqual([
        {
          inputRef: {
            kind: 'inline',
            value: { retained: true },
          },
        },
      ]);
    });
  });

  it('returns the existing run for an exact retry and rejects a changed request hash', async () => {
    const first = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptWorkflowRun(transaction, acceptanceInput()),
    );
    const retry = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
      acceptWorkflowRun(transaction, acceptanceInput()),
    );

    expect(retry).toEqual({ ...first, duplicate: true });
    await expect(
      apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput(otherRequestHash)),
      ),
    ).rejects.toBeInstanceOf(IdempotencyRequestConflictError);
    await expectAcceptanceRecordCounts(1);
  });

  it.each(['suspended', 'pending_deletion', 'deleted'] as const)(
    'returns durable accepted truth for an exact retry after the workspace becomes %s',
    async (status) => {
      const first = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      );
      const owner = new Pool({ connectionString: migrationUrl, max: 1 });
      try {
        await owner.query('set role pertexo_owner');
        await owner.query(
          `update app.workspaces
           set status = $2::varchar,
               name = case when $2::text = 'deleted' then 'Deleted workspace' else name end,
               slug = case when $2::text = 'deleted' then 'deleted-' || id::text else slug end,
               created_by = case when $2::text = 'deleted' then null else created_by end,
               deletion_requested_at = case when $2::text = 'suspended' then null else now() end,
               deletion_requested_by = case when $2::text = 'pending_deletion' then $3::uuid else null::uuid end,
               deletion_reason = case $2::text when 'suspended' then null::varchar
                 when 'deleted' then 'purged'::varchar else 'fixture deletion'::varchar end,
               purge_after = case when $2::text = 'suspended' then null else now() + interval '30 days' end
           where id = $1`,
          [workspaceA, status, workspaceCreatorId],
        );
      } finally {
        await owner.end();
      }

      const replay = await apiDatabase.withWorkspace(
        workspaceA,
        (transaction) => acceptWorkflowRun(transaction, acceptanceInput()),
      );
      expect(replay).toEqual({ ...first, duplicate: true });
      await expect(
        apiDatabase.withWorkspace(workspaceA, (transaction) =>
          acceptWorkflowRun(transaction, acceptanceInput(otherRequestHash)),
        ),
      ).rejects.toBeInstanceOf(IdempotencyRequestConflictError);
      if (status !== 'pending_deletion') await expectAcceptanceRecordCounts(1);
    },
  );

  it('rolls the entire acceptance back when its surrounding transaction fails', async () => {
    await expect(
      apiDatabase.withWorkspace(workspaceA, async (transaction) => {
        await acceptWorkflowRun(transaction, acceptanceInput());
        throw new Error('injected post-acceptance failure');
      }),
    ).rejects.toThrow('injected post-acceptance failure');

    await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
      const tables = [
        idempotencyRecords,
        workflowRuns,
        runEvents,
        runCheckpoints,
        outboxEvents,
      ] as const;
      for (const table of tables) {
        expect(await db.select({ count: count() }).from(table)).toEqual([
          { count: 0 },
        ]);
      }
    });
  });
}
