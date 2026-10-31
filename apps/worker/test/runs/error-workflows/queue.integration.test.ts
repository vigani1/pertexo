import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NodeExecutorFailure } from '@pertexo/node-sdk/server';
import { createPlatformNodeRegistry } from '@pertexo/node-catalog/server';
import {
  createOutboxDispatcherDatabase,
  parseDatabaseConfig,
} from '@pertexo/database/testing';
import { createQueueProducer, JOB_NAME } from '@pertexo/queue';
import { createMaintenanceRuntime } from '../../../src/maintenance/runtime.js';
import { OutboxDispatcher } from '../../../src/transport/outbox/dispatch/runtime.js';
import { WorkerDrainState } from '../../../src/runtime/shutdown/drain-state.js';
import {
  fixture,
  node,
  edge,
  publishGraph,
  accept,
  runtime,
} from '../calls/fixtures.js';

describe.runIf(fixture.enabled)(
  'error-workflow capacity waiting through real transport',
  () => {
    beforeAll(fixture.setup, 60_000);
    afterAll(fixture.restoreServicesAndClose);

    it.each(['free', 'expired'] as const)(
      'preserves its deadline after worker restart and settles when capacity is %s',
      async (outcome) => {
        const source = await publishGraph({
          settings: { maxRunDurationMs: 60_000 },
          nodes: [
            node('manual', 'core.manual'),
            node('source', 'core.set'),
            node('stop', 'core.terminate'),
          ],
          edges: [edge('manual', 'source'), edge('source', 'stop')],
        });
        const target = await publishGraph({
          settings: { maxRunDurationMs: 60_000 },
          nodes: [
            node('error', 'core.workflow_error'),
            node('stop', 'core.terminate'),
          ],
          edges: [edge('error', 'stop')],
        });
        await fixture.ownerQuery(
          'update app.workflows set published_version_id=$2 where id=$1',
          [target.workflowId, target.workflowVersionId],
        );
        await fixture.ownerQuery(
          'insert into app.workflow_error_policies(workspace_id,workflow_id,target_workflow_id) values($1,$2,$3)',
          [fixture.workspaceId, source.workflowId, target.workflowId],
        );
        const registry = createPlatformNodeRegistry();
        const workers = await runtime({
          ...registry,
          execute: (request) => {
            if (request.runtime?.nodeId === 'source')
              throw new NodeExecutorFailure({
                kind: 'failed',
                errorKind: 'authentication',
                possiblyDispatched: false,
              });
            return registry.execute(request);
          },
        });
        const database = parseDatabaseConfig({
          connectionString: fixture.databaseUrl(fixture.workerUrl),
          max: 3,
        });
        const maintenanceDatabase = parseDatabaseConfig({
          connectionString: fixture.databaseUrl(fixture.dispatcherUrl),
          max: 2,
        });
        let maintenance:
          Awaited<ReturnType<typeof createMaintenanceRuntime>> | undefined;
        let dispatcher: OutboxDispatcher | undefined;
        const blocker = randomUUID();
        const owners: { close(): Promise<unknown> }[] = [workers];
        let primary: Error | undefined;
        const cleanupFailures: unknown[] = [];
        try {
          const accepted = await accept(source);
          const runId = accepted.runId;
          await workers.until(async () => {
            expect(
              await fixture.workerQuery(
                'select status from app.workflow_runs where id=$1',
                [runId],
              ),
            ).toEqual([{ status: 'failed' }]);
          });
          await fixture.ownerQuery(
            'insert into app.workspace_execution_entitlement_versions(workspace_id,version,active_run_limit,queued_run_limit) select $1,max(version)+1,5,1 from app.workspace_execution_entitlement_versions where workspace_id=$1',
            [fixture.workspaceId],
          );
          await fixture.ownerQuery(
            'update app.workspace_execution_entitlements set current_version=(select max(version) from app.workspace_execution_entitlement_versions where workspace_id=$1) where workspace_id=$1',
            [fixture.workspaceId],
          );
          await fixture.workerQuery(
            "insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status) values($1,$2,$3,$4,'manual','queued')",
            [
              blocker,
              fixture.workspaceId,
              source.workflowId,
              source.workflowVersionId,
            ],
          );
          maintenance = await createMaintenanceRuntime({
            database,
            redisUrl: fixture.redisUrl,
          });
          const outbox = createOutboxDispatcherDatabase(maintenanceDatabase);
          owners.push(outbox);
          const producer = createQueueProducer({ redisUrl: fixture.redisUrl });
          owners.push(producer);
          dispatcher = new OutboxDispatcher(outbox, producer, {
            drainState: new WorkerDrainState(),
            options: {
              batchSize: 10,
              jobNames: [JOB_NAME.startErrorWorkflow],
              leaseDurationMillis: 1_000,
              leaseOwner: `error-capacity-${randomUUID()}`,
              retryDelayMillis: 100,
              pollIntervalMillis: 25,
            },
          });
          owners.splice(-2, 2, dispatcher);
          await Promise.all([
            maintenance.consumer.waitUntilReady(5_000),
            producer.waitUntilReady(5_000),
          ]);
          const read = async () =>
            (
              await fixture.workerQuery<{
                status: string;
                queue_wait_expires_at: Date | null;
                accepted_run_id: string | null;
                refusal_code: string | null;
              }>(
                'select status,queue_wait_expires_at,accepted_run_id,refusal_code from app.run_error_workflow_intents where source_run_id=$1',
                [runId],
              )
            )[0];
          await workers.until(async () => {
            await dispatcher?.dispatchOnce();
            expect(await read()).toMatchObject({
              status: 'pending',
              accepted_run_id: null,
            });
            expect((await read())?.queue_wait_expires_at).toBeInstanceOf(Date);
          });
          const deadline = (await read())?.queue_wait_expires_at;
          await maintenance.close();
          maintenance = await createMaintenanceRuntime({
            database,
            redisUrl: fixture.redisUrl,
          });
          await maintenance.consumer.waitUntilReady(5_000);
          expect((await read())?.queue_wait_expires_at).toEqual(deadline);
          if (outcome === 'free')
            await fixture.ownerQuery(
              "update app.workflow_runs set status='canceled',completed_at=clock_timestamp() where id=$1",
              [blocker],
            );
          else
            await fixture.ownerQuery(
              "update app.run_error_workflow_intents set queue_wait_expires_at=clock_timestamp()-interval '1 second' where source_run_id=$1",
              [runId],
            );
          await fixture.ownerQuery(
            'update app.outbox_events event set available_at=clock_timestamp() from app.run_error_workflow_intents intent where intent.source_run_id=$1 and event.id=intent.outbox_event_id',
            [runId],
          );
          await workers.until(async () => {
            await dispatcher?.dispatchOnce();
            expect(await read()).toMatchObject({
              status: outcome === 'free' ? 'accepted' : 'refused',
            });
          });
          const settled = await read();
          if (outcome === 'free') {
            expect(settled?.queue_wait_expires_at).toEqual(deadline);
            await workers.until(async () => {
              expect(
                await fixture.workerQuery(
                  'select status,workflow_version_id from app.workflow_runs where id=$1',
                  [settled?.accepted_run_id],
                ),
              ).toEqual([
                {
                  status: 'succeeded',
                  workflow_version_id: target.workflowVersionId,
                },
              ]);
            });
          } else
            expect(settled).toMatchObject({
              refusal_code: 'queue_full',
              accepted_run_id: null,
            });
          expect(
            await fixture.workerQuery(
              'select status from app.workflow_runs where id=$1',
              [runId],
            ),
          ).toEqual([{ status: 'failed' }]);
          expect(
            (
              await fixture.workerQuery(
                "select id from app.workflow_runs where workflow_id=$1 and trigger_type='workflow_error'",
                [target.workflowId],
              )
            ).length,
          ).toBe(outcome === 'free' ? 1 : 0);
        } catch (error: unknown) {
          primary =
            error instanceof Error
              ? error
              : new Error('Capacity-wait test failed', { cause: error });
        } finally {
          await fixture
            .ownerQuery(
              "update app.workflow_runs set status='canceled',completed_at=clock_timestamp() where id=$1 and status='queued'",
              [blocker],
            )
            .catch((error: unknown) => cleanupFailures.push(error));
          await maintenance
            ?.close()
            .catch((error: unknown) => cleanupFailures.push(error));
          for (const owner of owners.reverse())
            await owner
              .close()
              .catch((error: unknown) => cleanupFailures.push(error));
        }
        if (primary !== undefined) throw primary;
        if (cleanupFailures.length > 0)
          throw new AggregateError(
            cleanupFailures,
            'Capacity-wait fixture did not close',
          );
      },
      30_000,
    );
  },
);
