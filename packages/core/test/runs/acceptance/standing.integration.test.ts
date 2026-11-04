import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import {
  entitlementPolicyState,
  entitlementPolicyStateAt,
} from '../../../src/runs/queries/entitlement-effect.js';
import {
  acceptWorkflowRun,
  prepareWorkflowRunAcceptance,
} from '../../../src/runs/commands/acceptance/accept.js';
import { WorkspaceRunAdmissionDeniedError } from '../../../src/runs/commands/acceptance/run-admission.errors.js';
import { withOwner } from '../../authoring/settings/concurrency-admission.fixtures.js';
import {
  acceptanceInput,
  apiDatabase,
  expectAcceptanceRecordCounts,
  installExecutionAcceptanceFixture,
  lockManualFixtureStart,
  migrationUrl,
  waitForDatabaseLock,
  workspaceA,
  workflowId,
} from './run-acceptance.fixture.js';

installExecutionAcceptanceFixture();
let version = 100;
const triggerTypes = [
  'api',
  'manual',
  'replay',
  'schedule',
  'webhook',
  'workflow_call',
  'workflow_error',
  'form',
  'test',
] as const;
const standingCases = [
  {
    name: 'suspended',
    status: 'suspended',
    effective: '-infinity',
    expires: null,
  },
  {
    name: 'not yet effective',
    status: 'active',
    effective: 'infinity',
    expires: null,
  },
  {
    name: 'expired',
    status: 'active',
    effective: '-infinity',
    expires: '2000-01-01',
  },
] as const;
async function installStanding(state: (typeof standingCases)[number]) {
  const next = version++;
  await withOwner(async (client) => {
    await client.query(
      `insert into app.workspace_execution_entitlement_versions(workspace_id,version,status,active_run_limit,queued_run_limit,effective_at,expires_at)
      values($1,$2,$3,5,100,$4::timestamptz,$5::timestamptz)`,
      [workspaceA, next, state.status, state.effective, state.expires],
    );
    await client.query(
      'update app.workspace_execution_entitlements set current_version=$2 where workspace_id=$1',
      [workspaceA, next],
    );
  });
}

describe('run writer standing under the shared acceptance owner', () => {
  for (const standing of standingCases) {
    it(`refuses preparation against ${standing.name} entitlement before accepting references`, async () => {
      await installStanding(standing);
      await expect(
        apiDatabase.withWorkspace(workspaceA, (tx) =>
          prepareWorkflowRunAcceptance(tx, workflowId),
        ),
      ).rejects.toBeInstanceOf(WorkspaceRunAdmissionDeniedError);
      await expectAcceptanceRecordCounts(0);
    });
    it.each(triggerTypes)(
      `refuses %s acceptance against ${standing.name} standing without adding a run, receipt, event or wakeup`,
      async (triggerType) => {
        const source =
          triggerType === 'replay'
            ? await apiDatabase.withWorkspace(workspaceA, (tx) =>
                acceptWorkflowRun(tx, acceptanceInput()),
              )
            : null;
        await installStanding(standing);
        await expect(
          apiDatabase.withWorkspace(workspaceA, async (tx) => {
            if (triggerType === 'manual') await lockManualFixtureStart(tx);
            return acceptWorkflowRun(tx, {
              ...acceptanceInput(),
              scope: 'standing:refused',
              triggerType,
              ...(triggerType === 'replay'
                ? {
                    replayCommandId: randomUUID(),
                    replaySourceRunId: source?.runId,
                  }
                : {}),
            });
          }),
        ).rejects.toBeInstanceOf(WorkspaceRunAdmissionDeniedError);
        await expectAcceptanceRecordCounts(source === null ? 0 : 1);
      },
    );
  }
  it.each([
    {
      label: 'inclusive effective time',
      status: 'active',
      effectiveAt: '2026-01-01T00:00:00.000000Z',
      expiresAt: null,
      expected: 'active',
    },
    {
      label: 'exclusive expiry',
      status: 'active',
      effectiveAt: '2000-01-01',
      expiresAt: '2026-01-01T00:00:00.000000Z',
      expected: 'expired',
    },
    {
      label: 'one microsecond before expiry',
      status: 'active',
      effectiveAt: '2000-01-01',
      expiresAt: '2026-01-01T00:00:00.000001Z',
      expected: 'active',
    },
    {
      label: 'one microsecond before effect',
      status: 'active',
      effectiveAt: '2026-01-01T00:00:00.000001Z',
      expiresAt: null,
      expected: 'not_yet_effective',
    },
    {
      label: 'suspension precedence',
      status: 'suspended',
      effectiveAt: 'infinity',
      expiresAt: null,
      expected: 'suspended',
    },
    {
      label: 'unbounded standing',
      status: 'active',
      effectiveAt: '-infinity',
      expiresAt: 'infinity',
      expected: 'active',
    },
  ] as const)(
    'keeps the SQL read and core admission consistent at $label',
    async ({ status, effectiveAt, expiresAt, expected }) => {
      await apiDatabase.withWorkspace(workspaceA, async ({ db }) => {
        const effective = sql`${effectiveAt}::timestamptz`,
          expires = sql`${expiresAt}::timestamptz`,
          observed = sql`'2026-01-01T00:00:00.000000Z'::timestamptz`;
        const projected = entitlementPolicyState(
          {
            status: sql`${status}`,
            effectiveAt: effective,
            expiresAt: expires,
          },
          observed,
        );
        const result = await db.execute<{
          state: string;
          effective: string;
          expires: string | null;
          observed: string;
        }>(sql`select ${projected} state,
        extract(epoch from ${effective})::text effective,extract(epoch from ${expires})::text expires,extract(epoch from ${observed})::text observed`);
        const row = result.rows[0];
        if (row === undefined) throw new Error('Standing read missing');
        expect(row.state).toBe(expected);
        expect(
          entitlementPolicyStateAt(
            {
              status,
              effectiveAt: Number(row.effective),
              expiresAt: row.expires === null ? null : Number(row.expires),
            },
            Number(row.observed),
          ),
        ).toBe(expected);
      });
    },
  );
  it.each(['workflow_call', 'test'] as const)(
    'rechecks %s standing after a capacity wait crosses expiry',
    async (triggerType) => {
      const next = version++;
      await withOwner(async (client) => {
        await client.query(
          `insert into app.workspace_execution_entitlement_versions(workspace_id,version,status,active_run_limit,queued_run_limit,effective_at,expires_at)
        values($1,$2,'active',5,100,'-infinity',clock_timestamp()+interval '1 second')`,
          [workspaceA, next],
        );
        await client.query(
          'update app.workspace_execution_entitlements set current_version=$2 where workspace_id=$1',
          [workspaceA, next],
        );
      });
      const owner = new Pool({ connectionString: migrationUrl, max: 1 });
      const holder = await owner.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await holder.query('begin');
        await holder.query('set local role pertexo_owner');
        await holder.query("select set_config('app.workspace_id',$1,true)", [
          workspaceA,
        ]);
        const pid = (
          await holder.query<{ pid: number }>('select pg_backend_pid() pid')
        ).rows[0]?.pid;
        if (pid === undefined) throw new Error('Missing holder PID');
        await holder.query(
          'select workspace_id from app.workspace_execution_admission_counters where workspace_id=$1 for update',
          [workspaceA],
        );
        pending = apiDatabase.withWorkspace(workspaceA, (tx) =>
          acceptWorkflowRun(tx, { ...acceptanceInput(), triggerType }),
        );
        const observed = pending.then(
          () => undefined,
          (error: unknown) => error,
        );
        await waitForDatabaseLock(pid);
        await holder.query(
          `select pg_sleep(greatest(0,extract(epoch from(expires_at-clock_timestamp()))+0.01))
        from app.workspace_execution_entitlement_versions where workspace_id=$1 and version=$2`,
          [workspaceA, next],
        );
        await holder.query('commit');
        expect(await observed).toBeInstanceOf(WorkspaceRunAdmissionDeniedError);
        await expectAcceptanceRecordCounts(0);
      } finally {
        await holder.query('rollback');
        if (pending !== undefined) await Promise.allSettled([pending]);
        holder.release();
        await owner.end();
      }
    },
  );
});
