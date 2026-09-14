import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';

const requireDatabaseDependency = createRequire(
  new URL('../../packages/database/package.json', import.meta.url),
);

const planOptions = 'ANALYZE, BUFFERS, WAL, SETTINGS, FORMAT JSON';
const POOL_CONTENTION_ROUNDS = 3;
const POOL_CONTENTION_HOLD_MILLIS = 60;
const MINIMUM_OBSERVED_CHECKOUT_WAIT_SECONDS = 0.04;
const DATABASE_CONNECTION_TIMEOUT_MILLIS = 2_000;
const DATABASE_QUERY_TIMEOUT_MILLIS = 30_000;
const REQUIRED_PLAN_NAMES = Object.freeze([
  'retention-keyset',
  'artifact-version-listing',
  'purge-discovery',
  'purge-claim',
  'purge-checkpoint',
  'tenant-row-page',
]);

function databaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  return url.toString();
}

function planFrom(result) {
  const value = result.rows[0]?.['QUERY PLAN'];
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    value[0]?.Plan === null ||
    typeof value[0]?.Plan !== 'object' ||
    Array.isArray(value[0]?.Plan)
  )
    throw new Error('PostgreSQL did not return structured query-plan evidence');
  return value[0];
}

export function validatePostgresEvidence(evidence) {
  if (evidence?.available !== true)
    throw new Error('PostgreSQL performance evidence is unavailable');
  if (
    !Array.isArray(evidence.poolCheckoutWaitSeconds) ||
    evidence.poolCheckoutWaitSeconds.length < POOL_CONTENTION_ROUNDS ||
    evidence.poolCheckoutWaitSeconds.some(
      (value) =>
        !Number.isFinite(value) ||
        value < MINIMUM_OBSERVED_CHECKOUT_WAIT_SECONDS,
    )
  )
    throw new Error('Pool checkout wait evidence is incomplete');
  if (
    !Number.isSafeInteger(evidence.instrumentedSqlQueryCount) ||
    evidence.instrumentedSqlQueryCount < 1
  )
    throw new Error('Instrumented SQL query count is missing');
  if (
    !Array.isArray(evidence.queryPlans) ||
    evidence.queryPlans.length !== REQUIRED_PLAN_NAMES.length ||
    new Set(evidence.queryPlans.map(({ name }) => name)).size !==
      REQUIRED_PLAN_NAMES.length ||
    evidence.queryPlans.some(({ name }) => !REQUIRED_PLAN_NAMES.includes(name))
  )
    throw new Error(
      'Required PostgreSQL query plans are missing or duplicated',
    );
  for (const name of REQUIRED_PLAN_NAMES) {
    const plan = evidence.queryPlans.find(
      (candidate) => candidate.name === name,
    );
    const rootPlan = plan?.plan?.Plan;
    const representativeRowNames = Object.keys(
      plan?.representativeRows ?? {},
    ).sort();
    if (
      plan?.role !== 'pertexo_maintenance' ||
      plan.planScope !== 'outer-function-call' ||
      plan.internalStatementPlanAvailable !== false ||
      rootPlan === null ||
      typeof rootPlan !== 'object' ||
      Array.isArray(rootPlan) ||
      typeof rootPlan['Node Type'] !== 'string' ||
      rootPlan['Node Type'].length === 0 ||
      !Number.isFinite(rootPlan['Actual Rows']) ||
      rootPlan['Actual Rows'] < 0 ||
      !Number.isFinite(rootPlan['Actual Loops']) ||
      rootPlan['Actual Loops'] < 0 ||
      !Number.isFinite(plan.plan['Planning Time']) ||
      plan.plan['Planning Time'] < 0 ||
      !Number.isFinite(plan.plan['Execution Time']) ||
      plan.plan['Execution Time'] < 0 ||
      plan.representativeRows === null ||
      typeof plan.representativeRows !== 'object' ||
      JSON.stringify(representativeRowNames) !==
        JSON.stringify(['artifacts', 'purgeWorkspaces', 'workspaces']) ||
      Object.values(plan.representativeRows).some(
        (count) => !Number.isSafeInteger(count) || count < 1,
      )
    )
      throw new Error(
        `${name}: representative maintenance-role plan is missing`,
      );
  }
  const runtime = evidence.databaseRuntime;
  if (
    runtime === null ||
    typeof runtime !== 'object' ||
    runtime.database !== 'pertexo' ||
    runtime.role !== 'pertexo_maintenance' ||
    typeof runtime.serverVersion !== 'string' ||
    runtime.serverVersion.length === 0 ||
    !Number.isSafeInteger(runtime.serverVersionNumber) ||
    runtime.serverVersionNumber < 1 ||
    !Array.isArray(runtime.extensions) ||
    !runtime.extensions.some(
      (extension) =>
        extension?.name === 'pg_stat_statements' &&
        typeof extension.version === 'string' &&
        extension.version.length > 0,
    ) ||
    runtime.settings === null ||
    typeof runtime.settings !== 'object' ||
    !Number.isSafeInteger(runtime.settings.maxConnections) ||
    runtime.settings.maxConnections < 1 ||
    !Number.isSafeInteger(runtime.settings.pgStatStatementsMax) ||
    runtime.settings.pgStatStatementsMax < 1 ||
    [
      'sharedBuffers',
      'workMem',
      'effectiveCacheSize',
      'jit',
      'trackIoTiming',
      'pgStatStatementsTrack',
    ].some(
      (name) =>
        typeof runtime.settings[name] !== 'string' ||
        runtime.settings[name].length === 0,
    ) ||
    typeof runtime.serviceIdentity?.image !== 'string' ||
    runtime.serviceIdentity.image.length === 0 ||
    !['loopback', 'network'].includes(runtime.serviceIdentity?.hostScope) ||
    typeof runtime.serviceIdentity?.portScope !== 'string' ||
    runtime.serviceIdentity.portScope.length === 0
  )
    throw new Error('PostgreSQL runtime identity and settings are incomplete');
  return evidence;
}

function settled(promise) {
  return Promise.resolve(promise).then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  );
}

function throwFailures(failures, message) {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}

function recordingMeter(metricNames) {
  const histograms = new Map();
  const meter = {
    createHistogram(name) {
      return {
        record(value, attributes) {
          const samples = histograms.get(name) ?? [];
          samples.push({ value, attributes });
          histograms.set(name, samples);
        },
      };
    },
    createObservableGauge() {
      return {
        addCallback() {
          return undefined;
        },
      };
    },
  };
  return {
    meter,
    checkoutSamples() {
      return (histograms.get(metricNames.poolCheckoutDuration) ?? [])
        .filter(({ attributes }) => attributes?.outcome === 'success')
        .map(({ value }) => value);
    },
    sqlRoundTrips() {
      return (histograms.get(metricNames.queryDuration) ?? []).length;
    },
  };
}

export async function runPoolContentionSamples(
  pool,
  wait = () => delay(POOL_CONTENTION_HOLD_MILLIS),
) {
  let samplingFailed = false;
  let samplingError;
  try {
    for (let round = 0; round < POOL_CONTENTION_ROUNDS; round += 1) {
      const owner = await pool.connect();
      let waiterOutcome;
      try {
        waiterOutcome = settled(pool.connect());
      } catch (error) {
        waiterOutcome = Promise.resolve({ status: 'rejected', reason: error });
      }
      const holdOutcome = settled(Promise.resolve().then(() => wait()));
      const hold = await holdOutcome;
      const failures = [];
      try {
        owner.release();
      } catch (error) {
        failures.push(error);
      }
      const checkout = await waiterOutcome;
      if (hold.status === 'rejected') failures.push(hold.reason);
      if (checkout.status === 'rejected') failures.push(checkout.reason);
      if (checkout.status === 'fulfilled') {
        const client = checkout.value;
        if (hold.status === 'fulfilled') {
          const query = await settled(
            Promise.resolve().then(() => client.query('select 1')),
          );
          if (query.status === 'rejected') failures.push(query.reason);
        }
        try {
          client.release();
        } catch (error) {
          failures.push(error);
        }
      }
      throwFailures(failures, 'PostgreSQL pool evidence sample setup failed');
    }
  } catch (error) {
    samplingFailed = true;
    samplingError = error;
  }
  try {
    await pool.end();
  } catch (cleanupError) {
    if (samplingFailed)
      throw new AggregateError(
        [samplingError, cleanupError],
        'PostgreSQL pool evidence failed and pool cleanup was incomplete',
      );
    throw cleanupError;
  }
  if (samplingFailed) throw samplingError;
}

async function capturePoolEvidence(environment) {
  const { createDatabasePool, DATABASE_METRIC_NAME } =
    await import('../../packages/database/dist/testing.js');
  const telemetry = recordingMeter(DATABASE_METRIC_NAME);
  const pool = createDatabasePool(
    {
      connectionString: environment.DATABASE_MAINTENANCE_URL,
      connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MILLIS,
      max: 1,
      query_timeout: DATABASE_QUERY_TIMEOUT_MILLIS,
      statement_timeout: DATABASE_QUERY_TIMEOUT_MILLIS,
    },
    {
      meter: telemetry.meter,
      monitorLockWaits: false,
      role: 'maintenance',
    },
  );
  await runPoolContentionSamples(pool);
  const successful = telemetry.checkoutSamples();
  return {
    // Each round first records an uncontended acquisition and then its waiter.
    poolCheckoutWaitSeconds: successful.filter((_, index) => index % 2 === 1),
    instrumentedSqlQueryCount: telemetry.sqlRoundTrips(),
  };
}

async function createRepresentativeFixture(owner) {
  const userId = randomUUID();
  const artifactWorkspaces = Array.from({ length: 40 }, () => randomUUID());
  const purgeWorkspaces = {
    checkpoint: randomUUID(),
    claim: randomUUID(),
    discovery: randomUUID(),
    tenantRows: randomUUID(),
  };
  const allWorkspaces = [
    ...artifactWorkspaces,
    ...Object.values(purgeWorkspaces),
  ];
  await owner.query('begin');
  try {
    await owner.query('set local role pertexo_owner');
    await owner.query(
      "insert into app.users(id,email,display_name) values($1,$2,'Q11 fixture')",
      [userId, `${userId}@example.test`],
    );
    for (const [index, workspaceId] of allWorkspaces.entries()) {
      const purge = Object.values(purgeWorkspaces).includes(workspaceId);
      await owner.query(
        `insert into app.workspaces
          (id,name,slug,status,created_by,deletion_requested_at,
           deletion_requested_by,deletion_reason,purge_after)
         values($1,'Q11 representative',$2,$3::varchar,$4::uuid,
           case when $3::varchar='active' then null else clock_timestamp()-interval '32 days' end,
           case when $3::varchar='active' then null else $4::uuid end,
           case when $3::varchar='active' then null else 'Q11 disposable fixture' end,
           case when $3::varchar='active' then null else clock_timestamp()-interval '1 day' end)`,
        [
          workspaceId,
          `q11-${String(index)}-${workspaceId}`.slice(0, 63),
          purge ? 'pending_deletion' : 'active',
          userId,
        ],
      );
    }
    for (const workspaceId of artifactWorkspaces) {
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      const values = [];
      const parameters = [];
      for (let index = 0; index < 10; index += 1) {
        const artifactId = randomUUID();
        const offset = parameters.length;
        parameters.push(
          artifactId,
          workspaceId,
          `workspaces/${workspaceId}/artifacts/${artifactId}`,
          new Date(Date.now() - (index + 1) * 60_000).toISOString(),
        );
        values.push(
          `($${offset + 1},$${offset + 2},'run-output',$${offset + 3},` +
            `'application/json',128,repeat('a',64),'available',` +
            `$${offset + 4}::timestamptz,clock_timestamp()-interval '1 day')`,
        );
      }
      await owner.query(
        `insert into app.artifacts
          (id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,
           status,expires_at,finalized_at) values ${values.join(',')}`,
        parameters,
      );
    }

    const purgeHash = 'b'.repeat(64);
    await owner.query(
      "select set_config('app.retention_control_transition','on',true)",
    );
    await owner.query(
      `update app.workspaces
          set retention_control_sequence=1,retention_control_hash=$1,
              status=case when id=$2 then 'pending_deletion' else 'purging' end
        where id=any($3::uuid[])`,
      [purgeHash, purgeWorkspaces.discovery, Object.values(purgeWorkspaces)],
    );

    const jobs = {};
    for (const [name, workspaceId] of Object.entries(purgeWorkspaces)) {
      if (name === 'discovery') continue;
      const jobId = randomUUID();
      jobs[name] = jobId;
      await owner.query(
        `insert into app.workspace_purge_jobs
          (id,workspace_id,command_id,actor_ref,reason,occurred_at,status,
           control_sequence,control_record_hash)
         values($1,$2,$3,'maintenance:q11','Q11 plan fixture',
           clock_timestamp()-interval '1 day','purging',1,$4)`,
        [jobId, workspaceId, randomUUID(), purgeHash],
      );
    }
    const checkpointToken = randomUUID();
    const tenantToken = randomUUID();
    await owner.query(
      `insert into app.workspace_purge_steps
        (job_id,step_name,status,attempt_count,lease_owner,lease_token,
         lease_fence,lease_acquired_at,lease_expires_at,completed_at)
       values
        ($1,'object_versions','pending',0,null,null,0,null,null,null),
        ($1,'tenant_rows','pending',0,null,null,0,null,null,null),
        ($2,'object_versions','running',1,'q11',$3,1,clock_timestamp(),
          clock_timestamp()+interval '1 minute',null),
        ($2,'tenant_rows','pending',0,null,null,0,null,null,null),
        ($4,'object_versions','completed',1,null,null,1,null,null,clock_timestamp()),
        ($4,'tenant_rows','running',1,'q11',$5,1,clock_timestamp(),
          clock_timestamp()+interval '1 minute',null)`,
      [
        jobs.claim,
        jobs.checkpoint,
        checkpointToken,
        jobs.tenantRows,
        tenantToken,
      ],
    );
    await owner.query('commit');
    return {
      artifactCursor: artifactWorkspaces[10],
      checkpointJobId: jobs.checkpoint,
      checkpointToken,
      claimJobId: jobs.claim,
      purgeHash,
      tenantJobId: jobs.tenantRows,
      tenantToken,
    };
  } catch (error) {
    await owner.query('rollback').catch(() => undefined);
    throw error;
  }
}

function normalizedPostgresServiceIdentity(environment) {
  const url = new URL(environment.DATABASE_MAINTENANCE_URL);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  return {
    image: environment.POSTGRES_IMAGE,
    hostScope: loopback ? 'loopback' : 'network',
    portScope: loopback ? 'ephemeral-loopback' : url.port || 'default',
  };
}

async function captureDatabaseRuntime(maintenance, environment) {
  const identity = await maintenance.query(
    `select current_database() database,
              current_user role,
              current_setting('server_version') server_version,
              current_setting('server_version_num')::int server_version_number,
              current_setting('max_connections')::int max_connections,
              current_setting('shared_buffers') shared_buffers,
              current_setting('work_mem') work_mem,
              current_setting('effective_cache_size') effective_cache_size,
              current_setting('jit') jit,
              current_setting('track_io_timing') track_io_timing,
              current_setting('pg_stat_statements.max')::int pg_stat_statements_max,
              current_setting('pg_stat_statements.track') pg_stat_statements_track`,
  );
  const extensions = await maintenance.query(
    `select extname name,extversion version
         from pg_extension
        order by extname`,
  );
  const row = identity.rows[0];
  return {
    database: row?.database,
    role: row?.role,
    serverVersion: row?.server_version,
    serverVersionNumber: Number(row?.server_version_number),
    extensions: extensions.rows.map(({ name, version }) => ({ name, version })),
    settings: {
      maxConnections: Number(row?.max_connections),
      sharedBuffers: row?.shared_buffers,
      workMem: row?.work_mem,
      effectiveCacheSize: row?.effective_cache_size,
      jit: row?.jit,
      trackIoTiming: row?.track_io_timing,
      pgStatStatementsMax: Number(row?.pg_stat_statements_max),
      pgStatStatementsTrack: row?.pg_stat_statements_track,
    },
    serviceIdentity: normalizedPostgresServiceIdentity(environment),
  };
}

async function capturePlans(environment, options = {}) {
  const { Client } = requireDatabaseDependency('pg');
  const DatabaseClient = options.Client ?? Client;
  const owner = new DatabaseClient({
    connectionString: databaseUrl(environment.DATABASE_MIGRATION_URL),
    connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MILLIS,
    query_timeout: DATABASE_QUERY_TIMEOUT_MILLIS,
    statement_timeout: DATABASE_QUERY_TIMEOUT_MILLIS,
  });
  const maintenance = new DatabaseClient({
    connectionString: databaseUrl(environment.DATABASE_MAINTENANCE_URL),
    connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MILLIS,
    query_timeout: DATABASE_QUERY_TIMEOUT_MILLIS,
    statement_timeout: DATABASE_QUERY_TIMEOUT_MILLIS,
  });
  let operationFailed = false;
  let operationError;
  let result;
  try {
    await owner.connect();
    await maintenance.connect();
    const fixture = await createRepresentativeFixture(owner);
    await owner.query('set role pertexo_owner');
    await owner.query(
      'analyze app.artifacts,app.workspaces,app.workspace_purge_jobs,app.workspace_purge_steps',
    );
    await owner.query('reset role');
    const queries = [
      {
        name: 'retention-keyset',
        text: `explain (${planOptions}) select * from app.find_due_run_artifact_retention(25)`,
        values: [],
      },
      {
        name: 'artifact-version-listing',
        text: `explain (${planOptions}) select * from app.enumerate_committed_tenant_artifacts($1,$2,100)`,
        values: [
          fixture.artifactCursor,
          '00000000-0000-0000-0000-000000000000',
        ],
      },
      {
        name: 'purge-discovery',
        text: `explain (${planOptions}) select * from app.find_due_workspace_purge()`,
        values: [],
      },
      {
        name: 'purge-claim',
        text: `explain (${planOptions}) select * from app.claim_workspace_purge_step($1,1,$2,'q11-plan',interval '1 minute')`,
        values: [fixture.claimJobId, fixture.purgeHash],
      },
      {
        name: 'purge-checkpoint',
        text: `explain (${planOptions}) select app.checkpoint_workspace_object_versions_page($1,$2,1,0,true,1,$3)`,
        values: [
          fixture.checkpointJobId,
          fixture.checkpointToken,
          fixture.purgeHash,
        ],
      },
      {
        name: 'tenant-row-page',
        text: `explain (${planOptions}) select * from app.execute_workspace_tenant_rows_page($1,$2,1,100,1,$3)`,
        values: [fixture.tenantJobId, fixture.tenantToken, fixture.purgeHash],
      },
    ];
    const plans = [];
    for (const query of queries) {
      const queryResult = await maintenance.query(query);
      plans.push({
        name: query.name,
        role: 'pertexo_maintenance',
        planScope: 'outer-function-call',
        internalStatementPlanAvailable: false,
        representativeRows: {
          artifacts: 400,
          purgeWorkspaces: 4,
          workspaces: 44,
        },
        plan: planFrom(queryResult),
      });
    }
    result = {
      queryPlans: plans,
      databaseRuntime: await captureDatabaseRuntime(maintenance, environment),
    };
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  const closing = await Promise.allSettled([maintenance.end(), owner.end()]);
  const closeFailures = closing
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (operationFailed || closeFailures.length > 0)
    throw new AggregateError(
      [...(operationFailed ? [operationError] : []), ...closeFailures],
      'PostgreSQL plan evidence collection failed',
    );
  return result;
}

export async function capturePostgresEvidence(
  environment = process.env,
  options = {},
) {
  if (
    !environment.DATABASE_MIGRATION_URL ||
    !environment.DATABASE_MAINTENANCE_URL
  )
    return {
      available: false,
      reason: 'isolated database roles were not provided',
    };
  const results = await Promise.allSettled([
    (options.capturePoolEvidence ?? capturePoolEvidence)(environment),
    (options.capturePlans ?? capturePlans)(environment, options),
  ]);
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  throwFailures(failures, 'PostgreSQL evidence collectors failed');
  const [pool, plans] = results.map(({ value }) => value);
  return validatePostgresEvidence({ available: true, ...pool, ...plans });
}
