import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  acceptWorkflowRun,
  RegionalWriteAdmissionPausedError,
} from '../src/execution-acceptance.js';
import {
  acceptanceInput,
  apiDatabase,
  expectAcceptanceRecordCounts,
  installExecutionAcceptanceFixture,
  migrationUrl,
  workerDatabase,
  workspaceA,
} from './execution-acceptance.fixtures.js';

installExecutionAcceptanceFixture();

describe('workflow run regional admission and replay', () => {
  it('fences new runs while preserving exact idempotent replay', async () => {
    const owner = new Pool({ connectionString: migrationUrl, max: 1 });
    const setAdmission = async (status: 'open' | 'paused'): Promise<void> => {
      const client = await owner.connect();
      try {
        await client.query('begin');
        await client.query('set local role pertexo_owner');
        await client.query(
          `update app.regional_write_admission
              set enforced=true,status=$1,replay_lag_millis=$2,
                  observed_at=now(),updated_at=now()
            where singleton`,
          [status, status === 'open' ? 0 : 300_000],
        );
        await client.query('commit');
      } catch (error: unknown) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    };
    try {
      await setAdmission('paused');
      await expect(
        apiDatabase.withWorkspace(workspaceA, (transaction) =>
          acceptWorkflowRun(transaction, acceptanceInput()),
        ),
      ).rejects.toBeInstanceOf(RegionalWriteAdmissionPausedError);
      await expectAcceptanceRecordCounts(0);

      await setAdmission('open');
      const first = await apiDatabase.withWorkspace(workspaceA, (transaction) =>
        acceptWorkflowRun(transaction, acceptanceInput()),
      );

      await setAdmission('paused');
      await expect(
        apiDatabase.withWorkspace(workspaceA, (transaction) =>
          acceptWorkflowRun(transaction, acceptanceInput()),
        ),
      ).resolves.toEqual({ ...first, duplicate: true });
      await expect(
        apiDatabase.withWorkspace(workspaceA, (transaction) =>
          acceptWorkflowRun(transaction, {
            ...acceptanceInput(),
            keyHash: createHash('sha256')
              .update('regional-fence-new-key')
              .digest('hex'),
          }),
        ),
      ).rejects.toBeInstanceOf(RegionalWriteAdmissionPausedError);
      await expectAcceptanceRecordCounts(1);
    } finally {
      await owner.end();
    }
  });

  it('accepts and replays a run under the worker role', async () => {
    const first = await workerDatabase.withWorkspace(
      workspaceA,
      (transaction) => acceptWorkflowRun(transaction, acceptanceInput()),
    );
    const replay = await workerDatabase.withWorkspace(
      workspaceA,
      (transaction) => acceptWorkflowRun(transaction, acceptanceInput()),
    );

    expect(first.duplicate).toBe(false);
    expect(replay).toEqual({ ...first, duplicate: true });
    await expectAcceptanceRecordCounts(1);
  });
});
