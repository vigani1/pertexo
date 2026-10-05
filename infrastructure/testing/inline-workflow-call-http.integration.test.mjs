import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import {
  createCompatibilityReleaseMaintenance,
  createCompatibilityReleaseReadinessProbe,
  migrateDatabase,
  parseDatabaseConfig,
} from '../../packages/database/dist/testing.js';
import { createOutboxDispatcherDatabase } from '../../packages/database/dist/execution.js';
import {
  createQueueProducer,
  JOB_NAME,
} from '../../packages/queue/dist/index.js';
import { workflowCallableContractIdentityV1 } from '../../packages/workflow-model/dist/workflow-call-closure.js';
import { createApiApplication } from '../../apps/api/dist/app.js';
import { createApiIdentityRuntime } from '../../apps/api/dist/platform/identity/identity-runtime.module.js';
import { LocalAuthenticationMailSink } from '../../apps/api/dist/identity-infrastructure/index.js';
import { createCoreWorkflowCompatibility } from '../../apps/api/dist/platform/workflow/workflow-compatibility.js';
import { createCoordinatorRuntime } from '../../apps/worker/dist/execution/coordinator-runtime.js';
import { createNodeAttemptRuntime } from '../../apps/worker/dist/execution/node-attempt-runtime.js';
import { WorkerDrainState } from '../../apps/worker/dist/runtime/worker-drain-state.js';
import { OutboxDispatcher } from '../../apps/worker/dist/transport/outbox-dispatcher.js';
import { createDispatchConsumerCapabilityRegistry } from '../../apps/worker/dist/transport/dispatch-consumer-capabilities.js';

// Dedicated qualification: missing services are failures, never skipped tests.
assert.equal(process.env.INLINE_WORKFLOW_CALL_HTTP_INTEGRATION, 'true');
for (const name of [
  'DATABASE_ADMIN_URL',
  'DATABASE_MIGRATION_URL',
  'DATABASE_API_URL',
  'DATABASE_WORKER_URL',
  'DATABASE_DISPATCHER_URL',
  'DATABASE_OPERATOR_URL',
  'REDIS_URL',
])
  assert.ok(
    process.env[name],
    `Required qualification environment is missing: ${name}`,
  );
const requireWorker = createRequire(
  new URL('../../apps/worker/package.json', import.meta.url),
);
const { Pool } = requireWorker('pg');
const requireApi = createRequire(
  new URL('../../apps/api/package.json', import.meta.url),
);
const { hashPassword } = await import(requireApi.resolve('better-auth/crypto'));
const { Redis } = requireWorker('ioredis');
const silent = Object.fromEntries(
  ['debug', 'error', 'fatal', 'info', 'trace', 'warn'].map((key) => [
    key,
    () => undefined,
  ]),
);
const telemetry = {
  enabled: false,
  started: false,
  start: () => undefined,
  shutdown: () => Promise.resolve(),
};
const origin = 'https://app.integration.test';

test(
  'registered HTTP parent → pinned JSON child → parent drains after OFF',
  { timeout: 180_000 },
  async () => {
    const name = `pertexo_test_f08_http_${randomUUID().replaceAll('-', '')}`;
    assert.match(name, /^pertexo_test_f08_http_[a-f0-9]{32}$/u);
    const databaseUrl = (base) => {
      const value = new URL(base);
      value.pathname = `/${name}`;
      return value.toString();
    };
    const config = (base) =>
      parseDatabaseConfig({
        connectionString: databaseUrl(base),
        connectionTimeoutMillis: 1_000,
        max: 8,
      });
    const resources = [];
    const own = (value) => {
      resources.push(value);
      return value;
    };
    const admin = new Pool({
      connectionString: process.env.DATABASE_ADMIN_URL,
      max: 1,
      connectionTimeoutMillis: 1_000,
      query_timeout: 10_000,
    });
    let created = false;
    let application;
    let redis;
    let redisControl;
    let redisOwned = false;
    let redisCleanable = false;
    const redisToken = randomUUID();
    const redisDatabase = 9;
    const redisLock = `pertexo:test:redis-db:${redisDatabase}:owner`;
    const redisTarget = new URL(process.env.REDIS_URL);
    redisTarget.pathname = `/${redisDatabase}`;
    const redisControlUrl = new URL(process.env.REDIS_URL);
    redisControlUrl.pathname = '/10';
    let pool;
    let cookie = '';
    let csrf = '';
    let address;
    async function send(method, path, body, headers = {}, status = 200) {
      const reply = await fetch(`${address}${path}`, {
        method,
        headers: {
          Origin: origin,
          'content-type': 'application/json',
          ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
      const value = await reply.json();
      // Never serialize auth cookies, credentials, arbitrary exceptions or causes.
      assert.equal(
        reply.status,
        status,
        `HTTP ${method} ${path.includes('/auth/') ? 'authentication' : 'workflow'}: ${reply.status}; problem=${value.code ?? 'none'}`,
      );
      return { reply, value };
    }
    async function boot(cohort) {
      const database = config(process.env.DATABASE_API_URL);
      const identity = {
        publicWebOrigin: origin,
        invitationTokenEncryption: {
          current: {
            version: 'invite-v1',
            key: Buffer.alloc(32, 0x3c).toString('base64'),
          },
          previous: [],
        },
        session: { ttlMillis: 3_600_000, secureCookie: false, sameSite: 'lax' },
        betterAuth: {
          secret: 'better-auth-only-integration-secret-with-32-plus-characters',
          mailMode: 'local',
          providers: {},
        },
      };
      const identityRuntime = await createApiIdentityRuntime(
        identity,
        database,
        { authenticationMail: new LocalAuthenticationMailSink() },
      );
      try {
        application = await createApiApplication(
          {
            database,
            host: '127.0.0.1',
            port: 3000,
            identity,
            nodeCompatibilityCohort: cohort,
            nodeEnv: 'test',
            redisUrl: redisTarget.toString(),
            observability: {
              environment: 'test',
              logLevel: 'silent',
              otlpHeaders: {},
              serviceName: 'pertexo-api',
              serviceVersion: 'f08-http',
            },
          },
          { logger: silent, telemetry, identityRuntime },
        );
      } catch (error) {
        await identityRuntime.close();
        throw error;
      }
      await application.listen(0, '127.0.0.1');
      address = await application.getUrl();
      await send('GET', '/health/ready');
    }
    try {
      redisControl = new Redis(redisControlUrl.toString(), {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
      });
      redisControl.on('error', () => undefined);
      await redisControl.connect();
      assert.equal(
        await redisControl.set(redisLock, redisToken, 'PX', 600_000, 'NX'),
        'OK',
        'Qualification Redis namespace is already owned',
      );
      redisOwned = true;
      redis = new Redis(redisTarget.toString(), {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
      });
      redis.on('error', () => undefined);
      await redis.connect();
      assert.equal(
        await redis.dbsize(),
        0,
        'Qualification Redis namespace must be empty',
      );
      redisCleanable = true;
      await admin.query(`create database "${name}" owner pertexo_owner`);
      created = true;
      await admin.query(`revoke all on database "${name}" from public`);
      await admin.query(
        `grant connect on database "${name}" to pertexo_migration, pertexo_api, pertexo_worker, pertexo_dispatcher, pertexo_operator`,
      );
      await migrateDatabase({
        connectionString: databaseUrl(process.env.DATABASE_MIGRATION_URL),
        ownerRole: 'pertexo_owner',
        apiRuntimeRole: 'pertexo_api',
        workerRuntimeRole: 'pertexo_worker',
        dispatcherRole: 'pertexo_dispatcher',
        operatorRole: 'pertexo_operator',
        maintenanceRole: 'pertexo_maintenance',
        lifecycleCommandRole: 'pertexo_lifecycle_command',
      });
      pool = own(
        new Pool({
          connectionString: databaseUrl(process.env.DATABASE_ADMIN_URL),
          max: 1,
          query_timeout: 10_000,
        }),
      );
      const actor = randomUUID();
      const email = `${actor}@example.test`;
      const password = `qualification-${randomUUID()}`;
      // Trusted identity fixture only. All workflow writes below use real HTTP.
      await pool.query(
        'insert into app.users(id,email,display_name,status,email_verified) values($1,$2,$3,$4,true)',
        [actor, email, 'F08 HTTP', 'active'],
      );
      await pool.query(
        'insert into app.auth_accounts(id,account_id,provider_id,user_id,password) values($1,$2::text,$3,$2::uuid,$4)',
        [randomUUID(), actor, 'credential', await hashPassword(password)],
      );
      await boot('core');
      const signed = await send('POST', '/v1/auth/sign-in/email', {
        email,
        password,
        callbackURL: '/workspaces',
      });
      const cookies = signed.reply.headers
        .getSetCookie()
        .map((value) => value.split(';', 1)[0]);
      cookie = cookies.join('; ');
      csrf = decodeURIComponent(
        cookies
          .find((value) => value.startsWith('pertexo_csrf='))
          ?.slice('pertexo_csrf='.length) ?? '',
      );
      assert.ok(cookie && csrf);
      const workspace = await send(
        'POST',
        '/v1/workspaces',
        { name: 'F08 real HTTP', slug: `f08-${actor.slice(0, 8)}` },
        { 'Idempotency-Key': randomUUID() },
        201,
      );
      const workspaceId = workspace.value.id;
      const node = (id, key, inputMappings = {}) => ({
        id,
        definition: { key, version: 1 },
        position: { x: 0, y: 0 },
        configVersion: 1,
        config: {},
        inputMappings,
        connectionRefs: {},
      });
      const ids = [];
      for (const label of ['Pinned JSON child', 'JSON Call parent']) {
        const draft = await send(
          'POST',
          `/v1/workspaces/${workspaceId}/workflows`,
          { name: label },
          { 'Idempotency-Key': randomUUID() },
          201,
        );
        const id = draft.value.workflow.id;
        ids.push(id);
        await send(
          'PUT',
          `/v1/workspaces/${workspaceId}/workflows/${id}/draft`,
          {
            graph: {
              schemaVersion: 1,
              settings: {},
              nodes: [node('manual', 'core.manual')],
              edges: [],
            },
          },
          { 'If-Match': draft.reply.headers.get('etag') },
        );
      }
      await application.close();
      application = undefined;
      // Normal append-only release transition, with real API/worker catalog probes.
      const releases = createCoreWorkflowCompatibility(
        'workflow_call_activation',
      ).releaseSupport.descriptions;
      const maintenance = own(
        createCompatibilityReleaseMaintenance(
          config(process.env.DATABASE_MIGRATION_URL),
        ),
      );
      for (let index = 1; index < releases.length; index += 1) {
        const predecessor = releases[index - 1];
        const target = releases[index];
        const apiProbe = createCompatibilityReleaseReadinessProbe(
          config(process.env.DATABASE_API_URL),
          [predecessor, target],
        );
        const workerProbe = createCompatibilityReleaseReadinessProbe(
          config(process.env.DATABASE_WORKER_URL),
          [predecessor, target],
        );
        try {
          await maintenance.prepare({
            actorId: 'f08-http-qualification',
            actorKind: 'deployment',
            expectedPredecessor: predecessor,
            reason: 'Disposable HTTP qualification',
            target,
          });
          await apiProbe.checkTarget(target);
          await workerProbe.checkTarget(target);
          const deploymentId = randomUUID();
          const approvalId = randomUUID();
          for (const roleKind of ['api', 'worker'])
            await maintenance.recordPreactivation({
              artifactId: `f08-${roleKind}`,
              checkId: randomUUID(),
              deploymentId,
              roleKind,
              target,
            });
          await maintenance.approve({
            actorId: 'f08-http-qualification',
            approvalId,
            deploymentId,
            reason: 'Verified disposable API and worker probes',
            requiredApiArtifacts: ['f08-api'],
            requiredWorkerArtifacts: ['f08-worker'],
            target,
          });
          await maintenance.activate({
            activationId: randomUUID(),
            actorId: 'f08-http-qualification',
            actorKind: 'deployment',
            approvalId,
            expectedPredecessor: predecessor,
            reason: 'Disposable HTTP qualification',
          });
        } finally {
          await apiProbe.close();
          await workerProbe.close();
        }
      }
      assert.equal(releases.at(-1).epoch, 40);
      await boot('workflow_call_activation');
      const operator = own(
        new Pool({
          connectionString: databaseUrl(process.env.DATABASE_OPERATOR_URL),
          max: 1,
          query_timeout: 10_000,
        }),
      );
      await operator.query(
        'update app.workflow_input_case_rollout set enabled=true where singleton',
      );
      const [childId, parentId] = ids;
      const path = (id) => `/v1/workspaces/${workspaceId}/workflows/${id}`;
      const callable = {
        schemaVersion: 1,
        input: { type: 'object', properties: {}, required: [] },
        result: {
          type: 'object',
          properties: { answer: { type: 'number' } },
          required: ['answer'],
        },
        resultSelector: { kind: 'node_output', nodeId: 'set', path: '$' },
      };
      const childDraft = await send('GET', `${path(childId)}/draft`);
      const childSaved = await send(
        'PUT',
        `${path(childId)}/draft`,
        {
          graph: {
            schemaVersion: 2,
            settings: {},
            nodes: [
              node('manual', 'core.manual'),
              node('set', 'core.set', {
                answer: { kind: 'literal', value: 42 },
              }),
            ],
            edges: [
              {
                id: 'manual-set',
                source: { nodeId: 'manual', port: 'out' },
                target: { nodeId: 'set', port: 'in' },
              },
            ],
            callable,
          },
        },
        { 'If-Match': childDraft.reply.headers.get('etag') },
      );
      const childPublished = await send(
        'POST',
        `${path(childId)}/publish`,
        {},
        {
          'If-Match': childSaved.reply.headers.get('etag'),
          'Idempotency-Key': randomUUID(),
        },
      );
      const call = node('call', 'core.workflow_call');
      call.config = {
        workflowId: childId,
        versionId: childPublished.value.version.id,
        checksum: childPublished.value.version.checksum,
        callableContractIdentity: workflowCallableContractIdentityV1(callable),
      };
      const parentGraph = {
        schemaVersion: 2,
        settings: {},
        nodes: [node('manual', 'core.manual'), call],
        edges: [
          {
            id: 'manual-call',
            source: { nodeId: 'manual', port: 'out' },
            target: { nodeId: 'call', port: 'in' },
          },
        ],
        callable: {
          ...callable,
          resultSelector: { kind: 'node_output', nodeId: 'call', path: '$' },
        },
      };
      const parentDraft = await send('GET', `${path(parentId)}/draft`);
      const saved = await send(
        'PUT',
        `${path(parentId)}/draft`,
        { graph: parentGraph },
        { 'If-Match': parentDraft.reply.headers.get('etag') },
      );
      const publishHeaders = {
        'If-Match': saved.reply.headers.get('etag'),
        'Idempotency-Key': randomUUID(),
      };
      assert.equal(
        (
          await send(
            'POST',
            `${path(parentId)}/publish`,
            {},
            publishHeaders,
            503,
          )
        ).value.code,
        'workflow.calls_unavailable',
      );
      await operator.query('select app.set_workflow_calls_enabled(true)');
      const parentPublished = await send(
        'POST',
        `${path(parentId)}/publish`,
        {},
        publishHeaders,
      );
      const runBody = {
        input: {},
        expectedPublishedVersionId: parentPublished.value.version.id,
      };
      const runHeaders = { 'Idempotency-Key': randomUUID() };
      const accepted = await send(
        'POST',
        `${path(parentId)}/runs`,
        runBody,
        runHeaders,
        202,
      );
      const runId = accepted.value.run.id;
      await operator.query('select app.set_workflow_calls_enabled(false)');
      assert.equal(
        (
          await send(
            'POST',
            `${path(parentId)}/runs`,
            runBody,
            { 'Idempotency-Key': randomUUID() },
            503,
          )
        ).value.code,
        'workflow.calls_unavailable',
      );
      assert.equal(
        (await send('POST', `${path(parentId)}/runs`, runBody, runHeaders, 202))
          .value.run.id,
        runId,
      );
      assert.equal(
        (await send('POST', `${path(parentId)}/publish`, {}, publishHeaders))
          .value.version.id,
        parentPublished.value.version.id,
      );
      const draftAfter = await send('GET', `${path(parentId)}/draft`);
      const changed = await send(
        'PUT',
        `${path(parentId)}/draft`,
        { graph: { ...parentGraph, settings: { maxRunDurationMs: 120_000 } } },
        { 'If-Match': draftAfter.reply.headers.get('etag') },
      );
      assert.equal(
        (
          await send(
            'POST',
            `${path(parentId)}/publish`,
            {},
            {
              'If-Match': changed.reply.headers.get('etag'),
              'Idempotency-Key': randomUUID(),
            },
            503,
          )
        ).value.code,
        'workflow.calls_unavailable',
      );
      const database = config(process.env.DATABASE_WORKER_URL);
      const coordinator = own(
        await createCoordinatorRuntime({
          database,
          maximumAdmissions: 2,
          releaseCohort: 'workflow_call_activation',
          redisUrl: redisTarget.toString(),
        }),
      );
      // Unused external boundaries fail closed; no workflow engine/store/readiness replacement.
      let externalCalls = 0;
      const unavailable = async () => {
        externalCalls += 1;
        throw new Error(
          'Inline qualification must not use external connection or artifact capabilities',
        );
      };
      const attempts = own(
        await createNodeAttemptRuntime(
          {
            database,
            heartbeatIntervalMillis: 1_000,
            leaseDurationSeconds: 10,
            releaseCohort: 'workflow_call_activation',
            redisUrl: redisTarget.toString(),
            workerId: `f08-http-${randomUUID()}`,
          },
          {
            runtimeCapabilities: {
              connections: () => ({ resolve: unavailable }),
              artifacts: () => ({ write: unavailable }),
            },
          },
        ),
      );
      await coordinator.checkReadiness();
      await attempts.checkReadiness();
      const dispatcher = own(
        new OutboxDispatcher(
          createOutboxDispatcherDatabase(
            config(process.env.DATABASE_DISPATCHER_URL),
          ),
          createQueueProducer({ redisUrl: redisTarget.toString() }),
          new WorkerDrainState(),
          {
            batchSize: 10,
            enabledJobNames: [
              JOB_NAME.advanceWorkflowRun,
              JOB_NAME.executeNodeAttempt,
            ],
            leaseDurationMillis: 1_000,
            leaseOwner: `f08-${randomUUID()}`,
            maxAttempts: 3,
            operationTimeoutMillis: 5_000,
            retryDelayMillis: 10,
            pollIntervalMillis: 25,
          },
          undefined,
          createDispatchConsumerCapabilityRegistry([
            {
              jobName: JOB_NAME.advanceWorkflowRun,
              consumer: coordinator.consumer,
            },
            {
              jobName: JOB_NAME.executeNodeAttempt,
              consumer: attempts.consumer,
            },
          ]),
        ),
      );
      await dispatcher.checkReadiness();
      dispatcher.start();
      let details;
      const deadline = Date.now() + 45_000;
      do {
        details = (
          await send('GET', `/v1/workspaces/${workspaceId}/runs/${runId}`)
        ).value;
        if (!['queued', 'running', 'waiting'].includes(details.run.status))
          break;
        await delay(100);
      } while (Date.now() < deadline);
      assert.equal(details.run.status, 'succeeded');
      assert.equal(details.callFamily.children.length, 1);
      const childRunId = details.callFamily.children[0].runId;
      const child = (
        await send('GET', `/v1/workspaces/${workspaceId}/runs/${childRunId}`)
      ).value;
      assert.equal(child.run.status, 'succeeded');
      assert.equal(child.callFamily.parentRunId, runId);
      const facts = (
        await pool.query(
          `select parent.output_ref parent,child.output_ref child,c.callee_workflow_version_id pin,c.outcome_kind outcome from app.workflow_calls c join app.workflow_runs parent on parent.id=c.parent_run_id join app.workflow_runs child on child.id=c.child_run_id where parent.id=$1 and child.id=$2`,
          [runId, childRunId],
        )
      ).rows[0];
      assert.equal(facts.pin, childPublished.value.version.id);
      assert.equal(facts.outcome, 'admitted');
      assert.deepEqual(facts.parent.value, { answer: 42 });
      assert.deepEqual(facts.child.value, { answer: 42 });
      assert.equal(externalCalls, 0);
      assert.equal(
        (
          await operator.query(
            'select enabled from app.workflow_call_rollout where singleton',
          )
        ).rows[0].enabled,
        false,
      );
    } finally {
      const failures = [];
      if (application)
        await application.close().catch((error) => failures.push(error));
      for (const resource of resources.reverse())
        await (resource.close ? resource.close() : resource.end()).catch(
          (error) => failures.push(error),
        );
      if (redis) await redis.quit().catch((error) => failures.push(error));
      if (redisControl && redisOwned) {
        await redisControl
          .eval(
            `if redis.call('get',KEYS[1]) ~= ARGV[1] then return 0 end if ARGV[3] == 'true' then redis.call('select',ARGV[2]) redis.call('flushdb') redis.call('select',10) end redis.call('del',KEYS[1]) return 1`,
            1,
            redisLock,
            redisToken,
            redisDatabase,
            String(redisCleanable),
          )
          .then((value) => assert.equal(value, 1))
          .catch((error) => failures.push(error));
      }
      if (redisControl)
        await redisControl.quit().catch((error) => failures.push(error));
      // Never drop a database beneath an unconfirmed live runtime.
      if (created && failures.length === 0) {
        const deadline = Date.now() + 10_000;
        while (true) {
          const count = (
            await admin.query(
              'select count(*)::int count from pg_stat_activity where datname=$1',
              [name],
            )
          ).rows[0].count;
          if (count === 0) break;
          assert.ok(
            Date.now() < deadline,
            'Disposable database clients did not disconnect',
          );
          await delay(100);
        }
        await admin.query(`drop database "${name}"`);
      }
      await admin.end();
      assert.equal(
        failures.length,
        0,
        'HTTP qualification resource cleanup failed',
      );
    }
  },
);
