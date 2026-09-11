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

function databaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  return url.toString();
}

function planFrom(result) {
  const value = result.rows[0]?.['QUERY PLAN'];
  if (!Array.isArray(value) || value[0]?.Plan === undefined)
    throw new Error('PostgreSQL did not return structured query-plan evidence');
  return value[0];
}

export function validatePostgresEvidence(evidence) {
  const requiredPlans = [
    'retention-keyset',
    'artifact-version-listing',
    'purge-discovery',
    'purge-claim',
    'purge-checkpoint',
    'tenant-row-page',
  ];
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
    !Number.isSafeInteger(evidence.instrumentedSqlRoundTrips) ||
    evidence.instrumentedSqlRoundTrips < 0
  )
    throw new Error('Instrumented SQL round-trip count is missing');
  for (const name of requiredPlans) {
    const plan = evidence.queryPlans?.find(
      (candidate) => candidate.name === name,
    );
    if (
      plan?.role !== 'pertexo_maintenance' ||
      plan.plan?.Plan === undefined ||
      !Number.isFinite(plan.plan['Execution Time']) ||
      plan.plan['Execution Time'] < 0
    )
      throw new Error(
        `${name}: representative maintenance-role plan is missing`,
      );
  }
  return evidence;
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
      const waiting = pool.connect();
      let waitFailed = false;
      let waitError;
      try {
        await wait();
      } catch (error) {
        waitFailed = true;
        waitError = error;
      } finally {
        owner.release();
      }
      let checkoutFailed = false;
      let checkoutError;
      let client;
      try {
        client = await waiting;
      } catch (error) {
        checkoutFailed = true;
        checkoutError = error;
      }
      if (client !== undefined)
        try {
          if (!waitFailed) await client.query('select 1');
        } finally {
          client.release();
        }
      const setupFailures = [
        ...(waitFailed ? [waitError] : []),
        ...(checkoutFailed ? [checkoutError] : []),
      ];
      if (setupFailures.length === 1) throw setupFailures[0];
      if (setupFailures.length > 1)
        throw new AggregateError(
          setupFailures,
          'PostgreSQL pool evidence sample setup failed',
        );
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
    { connectionString: environment.DATABASE_MAINTENANCE_URL, max: 1 },
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
    instrumentedSqlRoundTrips: telemetry.sqlRoundTrips(),
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

async function capturePlans(environment) {
  const { Client } = requireDatabaseDependency('pg');
  const owner = new Client({
    connectionString: databaseUrl(environment.DATABASE_MIGRATION_URL),
    connectionTimeoutMillis: 2_000,
  });
  const maintenance = new Client({
    connectionString: databaseUrl(environment.DATABASE_MAINTENANCE_URL),
    connectionTimeoutMillis: 2_000,
  });
  let ownerConnected = false;
  let maintenanceConnected = false;
  let operationFailed = false;
  let operationError;
  let plans;
  try {
    await owner.connect();
    ownerConnected = true;
    await maintenance.connect();
    maintenanceConnected = true;
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
    plans = [];
    for (const query of queries) {
      const result = await maintenance.query(query);
      plans.push({
        name: query.name,
        role: 'pertexo_maintenance',
        representativeRows: {
          artifacts: 400,
          purgeWorkspaces: 4,
          workspaces: 44,
        },
        plan: planFrom(result),
      });
    }
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  const closing = await Promise.allSettled([
    maintenanceConnected ? maintenance.end() : Promise.resolve(),
    ownerConnected ? owner.end() : Promise.resolve(),
  ]);
  const closeFailures = closing
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (operationFailed || closeFailures.length > 0)
    throw new AggregateError(
      [...(operationFailed ? [operationError] : []), ...closeFailures],
      'PostgreSQL plan evidence collection failed',
    );
  return plans;
}

export async function capturePostgresEvidence(environment = process.env) {
  if (
    !environment.DATABASE_MIGRATION_URL ||
    !environment.DATABASE_MAINTENANCE_URL
  )
    return {
      available: false,
      reason: 'isolated database roles were not provided',
    };
  const [pool, queryPlans] = await Promise.all([
    capturePoolEvidence(environment),
    capturePlans(environment),
  ]);
  return validatePostgresEvidence({ available: true, ...pool, queryPlans });
}
