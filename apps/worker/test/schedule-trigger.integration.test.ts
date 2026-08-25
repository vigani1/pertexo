import { createHash, randomUUID } from 'node:crypto';

import {
  canonicalOutboxPayloadChecksum,
  createCompatibilityReleaseMaintenance,
  createCompatibilityReleaseReadinessProbe,
  createIdentityWorkspaceDatabase,
  createOutboxDispatcherDatabase,
  createScheduleTriggerScanner,
  createWorkflowAuthoringDatabase,
  migrateDatabase,
  parseDatabaseConfig,
  type DatabaseConfig,
} from '@pertexo/database';
import {
  platformExecutableRegistryHistory,
  platformRegistryReleaseSupport,
} from '@pertexo/node-catalog';
import {
  createQueueProducer,
  JOB_NAME,
  jobIdForOutboxEvent,
  QUEUE_NAME,
} from '@pertexo/queue';
import {
  buildWorkflowExecutableV2,
  composeExecutableCompatibilityRelease,
  createCheckpoint,
  createExecutableCompatibilityReleaseHistory,
  createExecutableCompatibilityReleaseSupport,
  describeExecutableCompatibilityRelease,
} from '@pertexo/workflow-engine';
import {
  workflowCompatibilityReport,
  workflowDraftRepresentationTag,
} from '@pertexo/workflow-model/graph';
import { Queue } from 'bullmq';
import { Pool, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { WorkerDrainState } from '../src/runtime/worker-drain-state.js';
import { createTriggerRuntime } from '../src/triggers/trigger-runtime.js';
import { createDispatchConsumerCapabilityRegistry } from '../src/transport/dispatch-consumer-capabilities.js';
import { OutboxDispatcher } from '../src/transport/outbox-dispatcher.js';

const enabled = process.env.WORKER_TRIGGER_INTEGRATION === 'true';
const describeIntegration = enabled ? describe : describe.skip;
const adminUrl =
  process.env.DATABASE_ADMIN_URL ??
  'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres';
const migrationBaseUrl =
  process.env.DATABASE_MIGRATION_URL ??
  'postgresql://pertexo_migration:pertexo-local-migration@localhost:5432/pertexo';
const apiBaseUrl =
  process.env.DATABASE_API_URL ??
  'postgresql://pertexo_api:pertexo-local-api@localhost:5432/pertexo';
const workerBaseUrl =
  process.env.DATABASE_WORKER_URL ??
  'postgresql://pertexo_worker:pertexo-local-worker@localhost:5432/pertexo';
const dispatcherBaseUrl =
  process.env.DATABASE_DISPATCHER_URL ??
  'postgresql://pertexo_dispatcher:pertexo-local-dispatcher@localhost:5432/pertexo';
const configuredRedisUrl =
  process.env.REDIS_URL ?? 'redis://:pertexo-local-redis@localhost:6379/0';
const redisUrl = (() => {
  const parsed = new URL(configuredRedisUrl);
  parsed.pathname = '/13';
  return parsed.toString();
})();
const databaseName = `pertexo_test_worker_schedule_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = (base: string): string => {
  const parsed = new URL(base);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
};
const databaseConfig = (base: string, max: number): DatabaseConfig =>
  parseDatabaseConfig({ connectionString: databaseUrl(base), max });
const actorId = randomUUID();
const workspaceId = randomUUID();
const releaseCohort = 'schedule_activation' as const;
const scheduleCompatibility = createExecutableCompatibilityReleaseSupport(
  platformRegistryReleaseSupport(releaseCohort).map(
    composeExecutableCompatibilityRelease,
  ),
).descriptions;

function authoringOptions() {
  const nodeReleases = platformExecutableRegistryHistory(releaseCohort);
  const history = createExecutableCompatibilityReleaseHistory(
    nodeReleases.map(composeExecutableCompatibilityRelease),
  );
  const readiness = createExecutableCompatibilityReleaseSupport(
    platformRegistryReleaseSupport(releaseCohort).map(
      composeExecutableCompatibilityRelease,
    ),
  );
  const variants = nodeReleases.map((nodeRelease) => {
    const release = composeExecutableCompatibilityRelease(nodeRelease);
    const description = history.descriptions.find(
      ({ epoch, fingerprint }) =>
        epoch === release.epoch && fingerprint === release.fingerprint,
    );
    if (description === undefined)
      throw new Error('Schedule compatibility description is missing');
    const catalog = (placement: boolean) =>
      Object.freeze({
        schemaVersion: 1 as const,
        releaseFingerprint: release.fingerprint,
        definitions: Object.freeze(
          nodeRelease.definitions
            .filter(
              (manifest) =>
                (manifest.lifecycle === 'active' ||
                  (!placement && manifest.lifecycle === 'deprecated')) &&
                nodeRelease.executors.some(
                  (executor) =>
                    executor.lifecycle === 'active' &&
                    executor.executor.key === manifest.executor.key &&
                    executor.executor.version === manifest.executor.version,
                ),
            )
            .map(({ definition, integration, connectionRequirements }) =>
              Object.freeze({
                ...definition,
                ...(integration === undefined
                  ? {}
                  : {
                      integration: Object.freeze({
                        ...integration,
                        connectionSlots: Object.freeze([
                          ...connectionRequirements,
                        ]),
                      }),
                    }),
              }),
            ),
        ),
      });
    return {
      compatibilityRelease: description,
      definitionCatalog: catalog(false),
      placementDefinitionCatalog: catalog(true),
      executableCompiler: (
        graph: Parameters<typeof buildWorkflowExecutableV2>[0]['graph'],
      ) => {
        const compiled = buildWorkflowExecutableV2({ graph, release });
        return {
          checksum: compiled.checksum,
          executableSchemaVersion: 2 as const,
          executableJson: compiled.envelope,
          compatibilityReleaseEpoch:
            compiled.envelope.compatibilityReleaseEpoch,
          compatibilityReleaseFingerprint:
            compiled.envelope.compatibilityReleaseFingerprint,
        };
      },
    };
  });
  const latest = variants.at(-1);
  if (latest === undefined)
    throw new Error('Schedule release history is empty');
  return {
    definitionCatalog: latest.definitionCatalog,
    databaseOptions: {
      compatibilityReadinessReleases: readiness.descriptions,
      compatibilityReleaseVariants: variants,
    },
  };
}

function bullConnection() {
  const parsed = new URL(redisUrl);
  return {
    db: Number(parsed.pathname.slice(1)),
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.password === ''
      ? {}
      : { password: decodeURIComponent(parsed.password) }),
  };
}

async function dropDatabase(): Promise<void> {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const active = await admin.query<{ count: number }>(
        `select count(*)::int count from pg_stat_activity
          where datname=$1 and pid<>pg_backend_pid()`,
        [databaseName],
      );
      if (active.rows[0]?.count === 0) {
        await admin.query(`drop database if exists "${databaseName}"`);
        return;
      }
      await admin.query('select pg_sleep(0.02)');
    }
    throw new Error('Disposable schedule database retained connections');
  } finally {
    await admin.end();
  }
}

describeIntegration('direct Schedule worker integration gate', () => {
  const apiConfig = databaseConfig(apiBaseUrl, 8);
  const workerConfig = databaseConfig(workerBaseUrl, 8);
  const dispatcherConfig = databaseConfig(dispatcherBaseUrl, 2);
  const owner = new Pool({
    connectionString: databaseUrl(migrationBaseUrl),
    max: 2,
  });
  const workerEvidence = new Pool({
    connectionString: databaseUrl(workerBaseUrl),
    max: 1,
  });
  const queue = new Queue(QUEUE_NAME.triggerLifecycle, {
    connection: bullConnection(),
  });
  const resources: { close(): Promise<void> }[] = [];

  async function ownerQuery<Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    parameters: unknown[] = [],
  ) {
    return ownerQueryIn<Row>(workspaceId, statement, parameters);
  }

  async function ownerQueryIn<Row extends QueryResultRow = QueryResultRow>(
    scopedWorkspaceId: string,
    statement: string,
    parameters: unknown[] = [],
  ) {
    const client = await owner.connect();
    try {
      await client.query('begin');
      await client.query('set local role pertexo_owner');
      await client.query("select set_config('app.workspace_id',$1,true)", [
        scopedWorkspaceId,
      ]);
      const result = await client.query<Row>(statement, parameters);
      await client.query('commit');
      return result;
    } catch (error: unknown) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function workerQuery<Row extends QueryResultRow = QueryResultRow>(
    statement: string,
    parameters: unknown[] = [],
  ) {
    const client = await workerEvidence.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      const result = await client.query<Row>(statement, parameters);
      await client.query('commit');
      return result;
    } catch (error: unknown) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function activateRelease(
    targetRelease: ReturnType<typeof platformExecutableRegistryHistory>[number],
  ): Promise<void> {
    const target = describeExecutableCompatibilityRelease(
      composeExecutableCompatibilityRelease(targetRelease),
    );
    const currentResult = await ownerQuery<{
      catalog_json: unknown;
      epoch: number;
      fingerprint: string;
    }>(
      `select current.epoch,current.fingerprint,release.catalog_json
         from app.node_compatibility_current current
         join app.node_compatibility_releases release
           on release.epoch=current.epoch and release.fingerprint=current.fingerprint`,
    );
    const current = currentResult.rows[0];
    if (current === undefined)
      throw new Error('Compatibility pointer is missing');
    if (
      current.epoch === target.epoch &&
      current.fingerprint === target.fingerprint
    )
      return;
    const predecessor = {
      catalogJson:
        typeof current.catalog_json === 'string'
          ? current.catalog_json
          : JSON.stringify(current.catalog_json),
      epoch: current.epoch,
      fingerprint: current.fingerprint,
    };
    const maintenance = createCompatibilityReleaseMaintenance(
      databaseConfig(migrationBaseUrl, 1),
    );
    const apiProbe = createCompatibilityReleaseReadinessProbe(apiConfig, [
      predecessor,
      target,
    ]);
    const workerProbe = createCompatibilityReleaseReadinessProbe(workerConfig, [
      predecessor,
      target,
    ]);
    const deploymentId = `schedule-release-${String(target.epoch)}-${randomUUID()}`;
    const approvalId = randomUUID();
    try {
      await maintenance.prepare({
        actorId: 'schedule-integration',
        actorKind: 'deployment',
        expectedPredecessor: predecessor,
        reason: 'Prepare direct Schedule integration release',
        target,
      });
      await Promise.all([
        apiProbe.checkTarget(target),
        workerProbe.checkTarget(target),
      ]);
      for (const roleKind of ['api', 'worker'] as const)
        await maintenance.recordPreactivation({
          artifactId: `schedule-${roleKind}-${String(target.epoch)}`,
          checkId: randomUUID(),
          deploymentId,
          roleKind,
          target,
        });
      await maintenance.approve({
        actorId: 'schedule-integration',
        approvalId,
        deploymentId,
        reason: 'Approve direct Schedule integration release',
        requiredApiArtifacts: [`schedule-api-${String(target.epoch)}`],
        requiredWorkerArtifacts: [`schedule-worker-${String(target.epoch)}`],
        target,
      });
      await maintenance.activate({
        activationId: randomUUID(),
        actorId: 'schedule-integration',
        actorKind: 'deployment',
        approvalId,
        expectedPredecessor: predecessor,
        reason: 'Activate direct Schedule integration release',
      });
    } finally {
      await Promise.allSettled([
        maintenance.close(),
        apiProbe.close(),
        workerProbe.close(),
      ]);
    }
  }

  beforeAll(async () => {
    const admin = new Pool({ connectionString: adminUrl, max: 1 });
    try {
      await admin.query(
        `create database "${databaseName}" owner pertexo_owner`,
      );
      await admin.query(`revoke all on database "${databaseName}" from public`);
      await admin.query(
        `grant connect on database "${databaseName}" to pertexo_migration,pertexo_api,pertexo_worker,pertexo_dispatcher`,
      );
    } finally {
      await admin.end();
    }
    await migrateDatabase({
      connectionString: databaseUrl(migrationBaseUrl),
      ownerRole: 'pertexo_owner',
      apiRuntimeRole: 'pertexo_api',
      workerRuntimeRole: 'pertexo_worker',
      dispatcherRole: 'pertexo_dispatcher',
    });
    for (const release of platformExecutableRegistryHistory(releaseCohort))
      await activateRelease(release);
    await queue.obliterate({ force: true });
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled(
      resources.splice(0).map((resource) => resource.close()),
    );
    await Promise.allSettled([
      queue.obliterate({ force: true }),
      owner.end(),
      workerEvidence.end(),
    ]);
    await queue.close();
    await dropDatabase();
  }, 60_000);

  it('keeps PostgreSQL authoritative through reconciliation, contention, saturation, recovery, and drain', async () => {
    const startedAt = performance.now();
    const scanErrors: unknown[] = [];
    const scanResults: unknown[] = [];
    const logger = {
      debug: () => undefined,
      error: (_event: string, _fields: unknown, error?: unknown) => {
        scanErrors.push(error);
      },
      fatal: () => undefined,
      info: () => undefined,
      trace: () => undefined,
      warn: () => undefined,
    };
    const identity = createIdentityWorkspaceDatabase(apiConfig);
    const compatibility = authoringOptions();
    const authoring = createWorkflowAuthoringDatabase(
      apiConfig,
      compatibility.databaseOptions,
    );
    resources.push(identity, authoring);
    await identity.createUser({
      id: actorId,
      email: `worker-schedule-${actorId}@example.test`,
      displayName: 'Worker Schedule Owner',
    });
    await identity.createWorkspaceWithOwner({
      id: workspaceId,
      name: 'Worker Schedule Proof',
      slug: `worker-schedule-${actorId}`,
      ownerUserId: actorId,
      idempotencyKey: `worker-schedule-${actorId}`,
    });
    const created = await authoring.createWorkflow({
      actorId,
      workspaceId,
      name: 'Direct Schedule worker proof',
      emptyGraph: { schemaVersion: 1, settings: {}, nodes: [], edges: [] },
      idempotencyKey: 'create-schedule-worker-proof',
    });
    const graph = {
      schemaVersion: 1,
      settings: {},
      nodes: [
        {
          id: 'schedule',
          definition: { key: 'core.schedule', version: 1 },
          position: { x: 0, y: 0 },
          configVersion: 1,
          config: {
            kind: 'interval',
            intervalMinutes: 1,
            misfirePolicy: 'catch_up_once',
          },
          inputMappings: {},
          connectionRefs: {},
        },
      ],
      edges: [],
    };
    const draft = await authoring.saveDraft({
      actorId,
      workspaceId,
      workflowId: created.workflowId,
      expectedRevision: 1,
      graphJson: graph,
    });
    const catalog = compatibility.definitionCatalog;
    const publication = await authoring.publishWorkflow({
      actorId,
      workspaceId,
      workflowId: created.workflowId,
      representationTag: workflowDraftRepresentationTag({
        workflowId: created.workflowId,
        revision: draft.revision,
        graph: draft.graphJson,
        compatibilityFingerprint: workflowCompatibilityReport(
          draft.graphJson,
          catalog,
        ).fingerprint,
      }),
      idempotencyKey: 'publish-schedule-worker-proof',
      requestHash: createHash('sha256')
        .update('publish-schedule-worker-proof')
        .digest('hex'),
    });
    const publicationEvent = await ownerQuery<{
      id: string;
      payload: Record<string, unknown>;
    }>(
      `select id,payload from app.outbox_events where aggregate_id=$1
        and job_name='reconcile-workflow-triggers'`,
      [created.workflowId],
    );
    const event = publicationEvent.rows[0];
    if (event === undefined) throw new Error('Publication outbox is missing');

    const runtimeScanner = createScheduleTriggerScanner(
      workerConfig,
      scheduleCompatibility,
      workerConfig,
    );
    let runtime = await createTriggerRuntime(
      {
        batchSize: 10,
        database: workerConfig,
        leaseDurationSeconds: 5,
        leaseOwner: 'schedule-runtime-one',
        pollIntervalMillis: 25,
        redisUrl,
        releaseCohort,
      },
      {
        logger,
        scanner: {
          close: () => runtimeScanner.close(),
          scanDue: async (input) => {
            const result = await runtimeScanner.scanDue(input);
            scanResults.push(result);
            return result;
          },
        },
      },
    );
    resources.push(runtime);
    await runtime.consumer.waitUntilReady(5_000);
    const drain = new WorkerDrainState();
    const dispatcher = new OutboxDispatcher(
      createOutboxDispatcherDatabase(dispatcherConfig),
      createQueueProducer({ redisUrl }),
      drain,
      {
        batchSize: 10,
        enabledJobNames: [JOB_NAME.reconcileWorkflowTriggers],
        leaseDurationMillis: 1_000,
        leaseOwner: 'schedule-publication-dispatcher',
        maxAttempts: 3,
        operationTimeoutMillis: 5_000,
        retryDelayMillis: 10,
      },
      undefined,
      createDispatchConsumerCapabilityRegistry([
        {
          jobName: JOB_NAME.reconcileWorkflowTriggers,
          consumer: runtime.consumer,
        },
      ]),
    );
    resources.push(dispatcher);
    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({
      published: 1,
    });
    await vi.waitFor(
      async () => {
        const materialized = await ownerQuery<{ count: string }>(
          `select count(*) count from app.trigger_schedules schedule
            join app.workflow_triggers trigger on trigger.id=schedule.trigger_id
           where trigger.workflow_id=$1 and trigger.status='active'`,
          [created.workflowId],
        );
        expect(materialized.rows[0]?.count).toBe('1');
      },
      { timeout: 5_000, interval: 25 },
    );

    await queue.remove(jobIdForOutboxEvent(event.id));
    const duplicateProducer = createQueueProducer({ redisUrl });
    await duplicateProducer.waitUntilReady(5_000);
    await duplicateProducer.publish({
      name: JOB_NAME.reconcileWorkflowTriggers,
      data: {
        schemaVersion: 1,
        workspaceId,
        workflowId: created.workflowId,
        publishedVersionId: publication.version.id,
        outboxEventId: event.id,
      },
    });
    await duplicateProducer.close();
    await vi.waitFor(
      async () => {
        const duplicateJob = await queue.getJob(jobIdForOutboxEvent(event.id));
        expect(await duplicateJob?.getState()).toBe('completed');
        const receipt = await workerQuery<{ count: string }>(
          `select count(*) count from app.inbox_receipts
            where consumer_name='trigger-runtime.reconciliation.v1'
              and message_id=$1 and completed_at is not null`,
          [event.id],
        );
        expect(receipt.rows[0]?.count).toBe('1');
      },
      { timeout: 5_000, interval: 25 },
    );

    const trigger = await ownerQuery<{ trigger_id: string }>(
      `select schedule.trigger_id from app.trigger_schedules schedule
        join app.workflow_triggers trigger on trigger.id=schedule.trigger_id
       where trigger.workflow_id=$1`,
      [created.workflowId],
    );
    const triggerId = trigger.rows[0]?.trigger_id;
    if (triggerId === undefined) throw new Error('Schedule trigger is missing');
    await ownerQuery(
      `with materialized as (
         delete from app.trigger_schedules where trigger_id=$1 returning *
       ) insert into app.trigger_schedules
         (trigger_id,workspace_id,recurrence_kind,cron_expression,timezone,
          interval_minutes,misfire_policy,config_fingerprint,anchor_at,next_fire_at,
          last_fire_at,status,health_status,last_error_code,created_at,updated_at,
          admission_deferred_until)
       select trigger_id,workspace_id,recurrence_kind,cron_expression,timezone,
          interval_minutes,misfire_policy,config_fingerprint,
          clock_timestamp()-interval '3 minutes',
          clock_timestamp()-interval '2 minutes',null,status,health_status,null,
          created_at,clock_timestamp(),null from materialized`,
      [triggerId],
    );
    const dueState = await ownerQuery<{
      admission_deferred_until: Date | null;
      due: boolean;
      status: string;
      trigger_status: string;
    }>(
      `select schedule.admission_deferred_until,
              schedule.next_fire_at<=clock_timestamp() due,schedule.status,
              trigger.status trigger_status
         from app.trigger_schedules schedule
         join app.workflow_triggers trigger on trigger.id=schedule.trigger_id
        where schedule.trigger_id=$1`,
      [triggerId],
    );
    expect(dueState.rows[0]).toEqual({
      admission_deferred_until: null,
      due: true,
      status: 'enabled',
      trigger_status: 'active',
    });
    await vi.waitFor(
      async () => {
        const occurrences = await ownerQuery<{ count: string }>(
          'select count(*) count from app.trigger_schedule_occurrences where trigger_id=$1',
          [triggerId],
        );
        expect(
          occurrences.rows[0]?.count,
          JSON.stringify({ scanErrors, scanResults }),
        ).toBe('1');
      },
      { timeout: 5_000, interval: 25 },
    );
    const first = await ownerQuery<{
      scheduled_at: Date;
      workflow_run_id: string;
    }>(
      `select scheduled_at,workflow_run_id from app.trigger_schedule_occurrences
        where trigger_id=$1`,
      [triggerId],
    );
    const firstOccurrence = first.rows[0];
    if (firstOccurrence === undefined)
      throw new Error('First schedule occurrence is missing');

    await runtime.close();
    resources.splice(resources.indexOf(runtime), 1);
    const scannerOne = createScheduleTriggerScanner(
      workerConfig,
      scheduleCompatibility,
      workerConfig,
    );
    const scannerTwo = createScheduleTriggerScanner(
      workerConfig,
      scheduleCompatibility,
      workerConfig,
    );
    resources.push(scannerOne, scannerTwo);
    const duplicateCheckpointFactory = () => ({
      engineVersion: 'phase3-engine-v1',
      checkpoint: createCheckpoint({
        engineVersion: 'phase3-engine-v1',
        workflowVersionId: publication.version.id,
        iterationBudget: 1_000,
        nextEventSequence: 2,
      }),
    });
    await ownerQuery(
      'update app.trigger_schedules set next_fire_at=$2,last_fire_at=null where trigger_id=$1',
      [triggerId, firstOccurrence.scheduled_at],
    );
    const duplicateScans = await Promise.all([
      scannerOne.scanDue({
        leaseOwner: 'competing-scanner-one',
        limit: 1,
        leaseSeconds: 5,
        checkpointFactory: duplicateCheckpointFactory,
      }),
      scannerTwo.scanDue({
        leaseOwner: 'competing-scanner-two',
        limit: 1,
        leaseSeconds: 5,
        checkpointFactory: duplicateCheckpointFactory,
      }),
    ]);
    expect(duplicateScans.reduce((sum, scan) => sum + scan.claimed, 0)).toBe(1);
    const uniqueFacts = await workerQuery<{
      checkpoints: string;
      events: string;
      outbox: string;
      runs: string;
    }>(
      `select
        (select count(*) from app.workflow_runs where id=$1) runs,
        (select count(*) from app.run_events where workflow_run_id=$1) events,
        (select count(*) from app.run_checkpoints where workflow_run_id=$1) checkpoints,
        (select count(*) from app.outbox_events where aggregate_id=$1
          and job_name='advance-workflow-run') outbox`,
      [firstOccurrence.workflow_run_id],
    );
    expect(uniqueFacts.rows[0]).toEqual({
      runs: '1',
      events: '1',
      checkpoints: '1',
      outbox: '1',
    });

    const otherActorId = randomUUID();
    const otherWorkspaceId = randomUUID();
    await identity.createUser({
      id: otherActorId,
      email: `worker-schedule-${otherActorId}@example.test`,
      displayName: 'Other Schedule Owner',
    });
    await identity.createWorkspaceWithOwner({
      id: otherWorkspaceId,
      name: 'Other Schedule Workspace',
      slug: `worker-schedule-${otherActorId}`,
      ownerUserId: otherActorId,
      idempotencyKey: `worker-schedule-${otherActorId}`,
    });
    const publishAdditionalSchedule = async (
      scopedWorkspaceId: string,
      scopedActorId: string,
      suffix: string,
    ) => {
      const createdSchedule = await authoring.createWorkflow({
        actorId: scopedActorId,
        workspaceId: scopedWorkspaceId,
        name: `Schedule ${suffix}`,
        emptyGraph: { schemaVersion: 1, settings: {}, nodes: [], edges: [] },
        idempotencyKey: `create-${suffix}`,
      });
      const saved = await authoring.saveDraft({
        actorId: scopedActorId,
        workspaceId: scopedWorkspaceId,
        workflowId: createdSchedule.workflowId,
        expectedRevision: 1,
        graphJson: graph,
      });
      const published = await authoring.publishWorkflow({
        actorId: scopedActorId,
        workspaceId: scopedWorkspaceId,
        workflowId: createdSchedule.workflowId,
        representationTag: workflowDraftRepresentationTag({
          workflowId: createdSchedule.workflowId,
          revision: saved.revision,
          graph: saved.graphJson,
          compatibilityFingerprint: workflowCompatibilityReport(
            saved.graphJson,
            catalog,
          ).fingerprint,
        }),
        idempotencyKey: `publish-${suffix}`,
        requestHash: createHash('sha256').update(suffix).digest('hex'),
      });
      return { workflowId: createdSchedule.workflowId, published };
    };
    const saturated = await publishAdditionalSchedule(
      workspaceId,
      actorId,
      'saturated',
    );
    const fair = await publishAdditionalSchedule(
      otherWorkspaceId,
      otherActorId,
      'fair',
    );

    runtime = await createTriggerRuntime({
      batchSize: 10,
      database: workerConfig,
      leaseDurationSeconds: 5,
      leaseOwner: 'schedule-runtime-reconstructed',
      pollIntervalMillis: 25,
      redisUrl,
      releaseCohort,
    });
    resources.push(runtime);
    await runtime.consumer.waitUntilReady(5_000);
    const recoveryDispatcher = new OutboxDispatcher(
      createOutboxDispatcherDatabase(dispatcherConfig),
      createQueueProducer({ redisUrl }),
      new WorkerDrainState(),
      {
        batchSize: 10,
        enabledJobNames: [JOB_NAME.reconcileWorkflowTriggers],
        leaseDurationMillis: 1_000,
        leaseOwner: 'schedule-recovery-dispatcher',
        maxAttempts: 3,
        operationTimeoutMillis: 5_000,
        retryDelayMillis: 10,
      },
      undefined,
      createDispatchConsumerCapabilityRegistry([
        {
          jobName: JOB_NAME.reconcileWorkflowTriggers,
          consumer: runtime.consumer,
        },
      ]),
    );
    resources.push(recoveryDispatcher);
    await expect(recoveryDispatcher.dispatchOnce()).resolves.toMatchObject({
      published: 2,
    });
    const scheduleTriggerId = async (
      scopedWorkspaceId: string,
      workflowId: string,
    ) => {
      let id: string | undefined;
      await vi.waitFor(
        async () => {
          const result = await ownerQueryIn<{ trigger_id: string }>(
            scopedWorkspaceId,
            `select schedule.trigger_id from app.trigger_schedules schedule
              join app.workflow_triggers trigger on trigger.id=schedule.trigger_id
             where trigger.workflow_id=$1 and trigger.status='active'`,
            [workflowId],
          );
          id = result.rows[0]?.trigger_id;
          expect(id).toBeDefined();
        },
        { timeout: 5_000, interval: 25 },
      );
      if (id === undefined) throw new Error('Additional schedule is missing');
      return id;
    };
    const saturatedTriggerId = await scheduleTriggerId(
      workspaceId,
      saturated.workflowId,
    );
    const fairTriggerId = await scheduleTriggerId(
      otherWorkspaceId,
      fair.workflowId,
    );
    const seedDue = (
      scopedWorkspaceId: string,
      seededTriggerId: string,
      ageMinutes: number,
    ) =>
      ownerQueryIn(
        scopedWorkspaceId,
        `with materialized as (
           delete from app.trigger_schedules where trigger_id=$1 returning *
         ) insert into app.trigger_schedules
           (trigger_id,workspace_id,recurrence_kind,cron_expression,timezone,
            interval_minutes,misfire_policy,config_fingerprint,anchor_at,next_fire_at,
            last_fire_at,status,health_status,last_error_code,created_at,updated_at,
            admission_deferred_until)
         select trigger_id,workspace_id,recurrence_kind,cron_expression,timezone,
            interval_minutes,misfire_policy,config_fingerprint,
            clock_timestamp()-make_interval(mins=>$2),
            clock_timestamp()-make_interval(mins=>$2-1),null,status,health_status,null,
            created_at,clock_timestamp(),null from materialized`,
        [seededTriggerId, ageMinutes],
      );
    await runtime.close();
    resources.splice(resources.indexOf(runtime), 1);
    await seedDue(workspaceId, saturatedTriggerId, 4);
    await seedDue(otherWorkspaceId, fairTriggerId, 3);

    await ownerQuery(
      `insert into app.workspace_execution_entitlement_versions
        (workspace_id,version,status,active_run_limit,queued_run_limit,effective_at)
       values($1,2,'active',5,1,'-infinity')`,
      [workspaceId],
    );
    await ownerQuery(
      `update app.workspace_execution_entitlements set current_version=2
        where workspace_id=$1`,
      [workspaceId],
    );
    const crashedClaim = await ownerQuery(
      'select * from app.claim_due_trigger_schedules($1,1,30)',
      ['expired-runtime'],
    );
    expect(crashedClaim.rows[0]).toMatchObject({
      trigger_id: saturatedTriggerId,
    });
    await ownerQuery(
      `update app.trigger_schedules
          set lease_acquired_at=clock_timestamp()-interval '2 seconds',
              lease_expires_at=clock_timestamp()-interval '1 second'
        where trigger_id=$1`,
      [saturatedTriggerId],
    );

    runtime = await createTriggerRuntime({
      batchSize: 10,
      database: workerConfig,
      leaseDurationSeconds: 5,
      leaseOwner: 'schedule-runtime-reconstructed',
      pollIntervalMillis: 25,
      redisUrl,
      releaseCohort,
    });
    resources.push(runtime);
    await runtime.consumer.waitUntilReady(5_000);
    await vi.waitFor(
      async () => {
        const backlog = await ownerQuery<{
          due: boolean;
          lease_owner: string | null;
          last_error_code: string | null;
        }>(
          `select next_fire_at<=clock_timestamp() due,lease_owner,last_error_code
             from app.trigger_schedules where trigger_id=$1`,
          [saturatedTriggerId],
        );
        expect(backlog.rows[0]).toEqual({
          due: true,
          lease_owner: null,
          last_error_code: 'schedule.admission_throttled',
        });
        const fairOccurrence = await ownerQueryIn<{ count: string }>(
          otherWorkspaceId,
          `select count(*) count from app.trigger_schedule_occurrences
            where trigger_id=$1`,
          [fairTriggerId],
        );
        expect(fairOccurrence.rows[0]?.count).toBe('1');
      },
      { timeout: 5_000, interval: 25 },
    );
    await ownerQuery(
      "update app.workflow_runs set status='succeeded' where id=$1",
      [firstOccurrence.workflow_run_id],
    );
    await ownerQuery(
      `update app.trigger_schedules set admission_deferred_until=null
        where trigger_id=$1`,
      [saturatedTriggerId],
    );
    await vi.waitFor(
      async () => {
        const recovered = await ownerQuery<{ count: string }>(
          'select count(*) count from app.trigger_schedule_occurrences where trigger_id=$1',
          [saturatedTriggerId],
        );
        expect(recovered.rows[0]?.count).toBe('1');
      },
      { timeout: 5_000, interval: 25 },
    );

    await runtime.close();
    resources.splice(resources.indexOf(runtime), 1);
    const beforeDrain = await ownerQuery<{ count: string }>(
      'select count(*) count from app.trigger_schedule_occurrences where trigger_id=$1',
      [triggerId],
    );
    await ownerQuery(
      `update app.trigger_schedules
          set next_fire_at=clock_timestamp()-interval '4 minutes',last_fire_at=null
       where trigger_id=$1`,
      [triggerId],
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const afterDrain = await ownerQuery<{
      count: string;
      due: boolean;
      lease_owner: string | null;
    }>(
      `select (select count(*) from app.trigger_schedule_occurrences where trigger_id=$1) count,
              next_fire_at<=clock_timestamp() due,lease_owner
         from app.trigger_schedules where trigger_id=$1`,
      [triggerId],
    );
    expect(afterDrain.rows[0]).toEqual({
      count: beforeDrain.rows[0]?.count,
      due: true,
      lease_owner: null,
    });
    expect(canonicalOutboxPayloadChecksum(event.payload)).toMatch(
      /^[0-9a-f]{64}$/u,
    );
    console.info(
      `Schedule worker integration completed in ${String(Math.round(performance.now() - startedAt))}ms`,
    );
  }, 30_000);
});
