import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WORKFLOW_CHECKPOINT_LIMITS } from '@pertexo/workflow-engine';
import {
  summarizeWorkflowCalls,
  validateCallDependencyClosure,
  validateWorkflowGraph,
  WORKFLOW_GRAPH_LIMITS,
} from '@pertexo/workflow-model';
import { migrateDatabase } from '../../../src/migrations.js';
import { createDisposableDatabaseFixture } from '../../../src/testing/postgres/disposable-database.js';
import { checkpoints } from './execute.js';
import {
  childGraph,
  childPin,
  loopScenarios,
  unsafeNestedGraph,
} from './scenarios.js';

const database = createDisposableDatabaseFixture({
  adminUrl:
    process.env.DATABASE_ADMIN_URL ??
    'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres',
  databaseName: `pertexo_test_loop_capacity_${randomUUID().slice(0, 8)}`,
  ownerRole: 'pertexo_owner',
  connectRoles: ['pertexo_migration'],
});
const connectionString = database.databaseUrl(
  process.env.DATABASE_MIGRATION_URL ??
    'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo',
);
const pool = new Pool({ connectionString, max: 1 });
beforeAll(async () => {
  if (process.env.PERTEXO_LOOP_CAPACITY_MEASURE !== '1') return;
  await database.create();
  await migrateDatabase({
    connectionString,
    ownerRole: 'pertexo_owner',
    appRole: 'pertexo_app',
    maintenanceRole: 'pertexo_maintenance',
  });
  await pool.query('set role pertexo_owner');
  // Production checkpoint columns, constraints and indexes, excluding foreign
  // keys and history/receipt/artifact work: these are checkpoint WAL costs only.
  await pool.query(
    'create table app.loop_checkpoint_probe (like app.run_checkpoints including all)',
  );
}, 60_000);
afterAll(async () => {
  await pool.end();
  if (process.env.PERTEXO_LOOP_CAPACITY_MEASURE === '1') await database.drop();
});

const measure =
  process.env.PERTEXO_LOOP_CAPACITY_MEASURE === '1' ? describe : describe.skip;
measure('maximum loop checkpoint writes', () => {
  it.each(loopScenarios())(
    '$name preserves bounded state and restart at the new limit',
    async (scenario) => {
      await pool.query('truncate app.loop_checkpoint_probe');
      const workspaceId = randomUUID();
      const parent = randomUUID();
      const validation = validateWorkflowGraph(scenario.graph);
      expect(validation.ok).toBe(true);
      const workspace = { workspaceId };
      const rootPin = {
        workflowId: randomUUID(),
        workflowVersionId: randomUUID(),
        executableChecksum: `wf:sha256:${'a'.repeat(64)}`,
      };
      const childSummary = summarizeWorkflowCalls(
        { ...workspace, ...childPin },
        childGraph,
        1,
      );
      const weighted = await validateCallDependencyClosure(
        summarizeWorkflowCalls(
          { ...workspace, ...rootPin },
          scenario.graph,
          validation.expandedInvocations,
        ),
        () => Promise.resolve(childSummary),
        WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations,
      );
      expect(weighted).toBe(WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations);
      let updates = 0,
        inserts = 0,
        rewriteBytes = 0,
        walBytes = 0,
        peakBytes = 0,
        maxInvocations = 0;
      const started = performance.now();
      const write = async (
        runId: string,
        sequence: ReturnType<typeof checkpoints>,
      ) => {
        let inserted = false;
        for await (const checkpoint of sequence) {
          const json = JSON.stringify(checkpoint);
          const bytes = Buffer.byteLength(json);
          peakBytes = Math.max(peakBytes, bytes);
          maxInvocations = Math.max(
            maxInvocations,
            checkpoint.invocations.length,
          );
          rewriteBytes += bytes;
          expect(bytes).toBeLessThan(WORKFLOW_CHECKPOINT_LIMITS.bytes * 0.9);
          expect(
            checkpoint.invocations.every(
              ({ invocationKey }) => invocationKey.length <= 256,
            ),
          ).toBe(true);
          if (!inserted) {
            const result = await pool.query<{
              'QUERY PLAN': { Plan: { 'WAL Bytes': number } }[];
            }>(
              'explain (analyze, wal, buffers, format json) insert into app.loop_checkpoint_probe(workspace_id,workflow_run_id,workflow_version_id,revision,scheduler_state) values($1,$2,$3,$4,$5)',
              [
                workspaceId,
                runId,
                checkpoint.workflowVersionId,
                checkpoint.revision,
                json,
              ],
            );
            walBytes +=
              result.rows[0]?.['QUERY PLAN'][0]?.Plan['WAL Bytes'] ?? 0;
            inserts++;
            inserted = true;
          } else {
            const result = await pool.query<{
              'QUERY PLAN': { Plan: { 'WAL Bytes': number } }[];
            }>(
              'explain (analyze, wal, buffers, format json) update app.loop_checkpoint_probe set revision=$2,scheduler_state=$3,updated_at=clock_timestamp() where workflow_run_id=$1',
              [runId, checkpoint.revision, json],
            );
            walBytes +=
              result.rows[0]?.['QUERY PLAN'][0]?.Plan['WAL Bytes'] ?? 0;
            updates++;
          }
        }
      };
      await write(parent, checkpoints(scenario));
      for (let index = 0; index < (scenario.calls ?? 0); index++)
        await write(
          randomUUID(),
          checkpoints({ name: 'child', graph: childGraph, collections: {} }),
        );
      const result = {
        scenario: scenario.name,
        weighted,
        updates,
        inserts,
        peakBytes,
        rewriteBytes,
        walBytes,
        maxInvocations,
        elapsedMillis: Math.round(performance.now() - started),
      };
      process.stdout.write(`LOOP_CAPACITY=${JSON.stringify(result)}\n`);
      expect(walBytes).toBeGreaterThan(0);
      expect(maxInvocations).toBeLessThanOrEqual(200);
    },
    300_000,
  );
});

it('rejects a nested frontier that overflows the checkpoint before publication', () => {
  expect(
    validateWorkflowGraph(unsafeNestedGraph()).issues.find(
      ({ code }) => code === 'expansion_limit',
    )?.message,
  ).toContain('reduce Items at a time');
});
