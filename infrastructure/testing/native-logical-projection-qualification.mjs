// F08 native step result integrity: finalized output and current-result
// qualification of the unregistered 0137 candidate.
//
// Run: node infrastructure/testing/native-logical-projection-qualification.mjs
//
// It starts one owned, labelled, network-less PostgreSQL container on tmpfs,
// installs every registered migration and the candidate (the candidate's
// install-abort block is removed in that container's copy only; the source
// file is never modified or registered), runs the scenarios as the real worker
// database role, and always removes the container. It needs Docker and the
// local `postgres:18-alpine` image; it never pulls images or opens ports.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const candidatePath =
  'packages/database/src/execution/workflow-calls/0137-native-execution-values.candidate.sql';
const roles = {
  owner_role: 'pertexo_owner',
  api_runtime_role: 'pertexo_api',
  worker_runtime_role: 'pertexo_worker',
  dispatcher_role: 'pertexo_dispatcher',
  maintenance_role: 'pertexo_maintenance',
  lifecycle_command_role: 'pertexo_lifecycle_command',
  operator_role: 'pertexo_operator',
};
const installAbort =
  /DO \$\$ BEGIN\n {2}RAISE EXCEPTION 'Unregistered F08 0137 review candidate: installation is not authorized';\nEND \$\$;\n/u;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function render(sql) {
  let rendered = sql;
  for (const [placeholder, role] of Object.entries(roles))
    rendered = rendered.replaceAll(`{{${placeholder}}}`, `"${role}"`);
  rendered = rendered.replaceAll(
    '{{regional_write_admission_enforced}}',
    'false',
  );
  if (rendered.includes('{{')) throw new Error('Unresolved SQL placeholder');
  return rendered;
}

function psql(container, sql, user = 'pertexo_migration') {
  return execFileSync(
    'docker',
    [
      'exec',
      '-i',
      container,
      'psql',
      '-X',
      '-q',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      user,
      '-d',
      'pertexo_f08',
    ],
    {
      input: sql,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
}

function waitForPostgres(container) {
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      const logs = execFileSync('docker', ['logs', container], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (
        logs.includes('PostgreSQL init process complete; ready for start up.')
      ) {
        execFileSync(
          'docker',
          ['exec', container, 'pg_isready', '-U', 'postgres'],
          { stdio: 'ignore' },
        );
        return;
      }
    } catch {
      // Not ready yet.
    }
    execFileSync('sleep', ['0.1']);
  }
  throw new Error('Owned PostgreSQL did not start');
}

function install(container) {
  const environment = [
    'POSTGRES_USER=postgres',
    'POSTGRES_DB=pertexo_f08',
    'POSTGRES_OWNER_USER=pertexo_owner',
  ];
  for (const [prefix, role] of [
    ['MIGRATION', 'pertexo_migration'],
    ['MAINTENANCE', 'pertexo_maintenance'],
    ['LIFECYCLE_COMMAND', 'pertexo_lifecycle_command'],
    ['OPERATOR', 'pertexo_operator'],
    ['API_RUNTIME', 'pertexo_api'],
    ['WORKER_RUNTIME', 'pertexo_worker'],
    ['DISPATCHER_RUNTIME', 'pertexo_dispatcher'],
  ])
    environment.push(
      `POSTGRES_${prefix}_USER=${role}`,
      `POSTGRES_${prefix}_PASSWORD=${randomBytes(24).toString('hex')}`,
    );
  execFileSync('docker', ['exec', '-i', container, 'bash'], {
    input:
      environment
        .map((value) => {
          const split = value.indexOf('=');
          return `export ${value.slice(0, split)}='${value.slice(split + 1)}'`;
        })
        .join('\n') +
      '\n' +
      readFileSync(
        `${repository}infrastructure/postgres/init/10-roles.sh`,
        'utf8',
      ),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  psql(
    container,
    `BEGIN; SET LOCAL ROLE pertexo_owner; CREATE SCHEMA pertexo_internal; REVOKE ALL ON SCHEMA pertexo_internal FROM PUBLIC;
     CREATE TABLE pertexo_internal.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
     CREATE TABLE pertexo_internal.migration_jobs (name text PRIMARY KEY, checksum text NOT NULL,
       batches_completed bigint NOT NULL DEFAULT 0 CHECK(batches_completed>=0), rows_processed bigint NOT NULL DEFAULT 0 CHECK(rows_processed>=0),
       status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed')), updated_at timestamptz NOT NULL DEFAULT now());
     COMMIT;`,
  );
  const migrations = readdirSync(`${repository}packages/database/migrations`)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
    .sort();
  for (const name of migrations) {
    // The two oldest backfills run before row security is forced, as in the runner.
    const backfill =
      name === '0006_execution_vocabulary.sql'
        ? ['workflow_runs', 'idempotency_records']
        : name === '0007_execution_runtime.sql'
          ? ['run_events']
          : [];
    psql(
      container,
      `BEGIN; SET LOCAL ROLE pertexo_owner; SET LOCAL statement_timeout='60s';
       ${backfill.map((table) => `ALTER TABLE app.${table} NO FORCE ROW LEVEL SECURITY;`).join('\n')}
       ${render(readFileSync(`${repository}packages/database/migrations/${name}`, 'utf8'))}
       ${backfill.map((table) => `ALTER TABLE app.${table} FORCE ROW LEVEL SECURITY;`).join('\n')}
       COMMIT;`,
    );
  }
  const candidate = readFileSync(`${repository}${candidatePath}`, 'utf8');
  if (!installAbort.test(candidate))
    throw new Error('Candidate install-abort block is not exactly present');
  psql(
    container,
    `BEGIN; SET LOCAL ROLE pertexo_owner; SET LOCAL statement_timeout='120s';
     ${render(candidate.replace(installAbort, ''))} COMMIT;`,
  );
}

const W = '11111111-1111-4111-8111-111111111111';
const R = '44444444-4444-4444-8444-444444444444';
const OTHER_RUN = '44444444-4444-4444-8444-444444444445';
const VERSION = '33333333-3333-4333-8333-333333333333';
const N = '55555555-5555-4555-8555-555555555555';
const RETAINED = '55555555-5555-4555-8555-555555555556';
const A = '66666666-6666-4666-8666-666666666666';
const P = '77777777-7777-4777-8777-777777777777';
const accepted = '{"schemaVersion":1,"kind":"inline","value":{"total":30}}';
const forged = '{"schemaVersion":1,"kind":"inline","value":{"total":999999}}';

/** One finished native step with its accepted output, plus a retained step. */
function seed(container) {
  psql(
    container,
    `BEGIN; SET LOCAL session_replication_role=replica;
     DELETE FROM app.inbox_receipts; DELETE FROM app.outbox_events; DELETE FROM app.run_checkpoints;
     DELETE FROM app.workflow_execution_value_provenance; DELETE FROM app.node_attempts; DELETE FROM app.node_runs;
     INSERT INTO app.node_runs(id,workspace_id,workflow_run_id,node_id,invocation_key,status,side_effect_class,
       output_ref,current_attempt_id,current_attempt_number,completed_at)
     VALUES('${N}','${W}','${R}','set','set#0','succeeded','safe','${accepted}','${A}',1,now()),
       ('${RETAINED}','${W}','${OTHER_RUN}','retained','retained#0','succeeded','safe','${accepted}',NULL,NULL,now());
     INSERT INTO app.node_attempts(id,workspace_id,node_run_id,attempt_number,status,side_effect_class,output_ref,completed_at)
     VALUES('${A}','${W}','${N}',1,'succeeded','safe','${accepted}',now());
     INSERT INTO app.workflow_execution_value_provenance(id,workspace_id,workflow_run_id,workflow_version_id,value_slot,
       byte_ownership,node_run_id,node_id,invocation_key,attempt_id,attempt_number,reference_kind,original_reference,
       original_inline_text,sha256,byte_length,media_type,accepted_at,eligible_until)
     VALUES('${P}','${W}','${R}','${VERSION}','attempt_output','owned','${N}','set','set#0','${A}',1,'inline',
       '${accepted}','{"total":30}','${sha256('{"total":30}')}',12,
       'application/vnd.pertexo.execution-value+json;version=1',now(),now()+interval '30 days');
     INSERT INTO app.run_checkpoints(workflow_run_id,workspace_id,revision,engine_version,scheduler_state,workflow_version_id)
     VALUES('${R}','${W}',4,'engine-3','{"schemaVersion":3}','${VERSION}'),
       ('${OTHER_RUN}','${W}',2,'engine-3','{"schemaVersion":3}','${VERSION}');
     COMMIT;`,
    'postgres',
  );
}

/** Runs statements as the worker role in one transaction; returns its error line or null. */
function asWorker(container, statements, finish = 'COMMIT') {
  try {
    psql(
      container,
      `BEGIN; SELECT set_config('app.workspace_id','${W}',true); ${statements} ${finish};`,
      'pertexo_worker',
    );
    return null;
  } catch (error) {
    const output = String(error.stderr ?? error.message);
    return (
      output.split('\n').find((line) => line.startsWith('ERROR')) ?? output
    );
  }
}

/** The coordinator's own transaction shape: claim, change, checkpoint CAS, complete. */
function coordinator(run, change, { cas = true, complete = true } = {}) {
  const event = randomUUID();
  const payload = `{"runId":"${run}","schemaVersion":1}`;
  return `INSERT INTO app.outbox_events(id,workspace_id,job_name,schema_version,aggregate_type,aggregate_id,payload,payload_checksum)
      VALUES('${event}','${W}','advance-workflow-run',1,'workflow-run','${run}','${payload}','${sha256(payload)}');
    INSERT INTO app.inbox_receipts(consumer_name,message_id,workspace_id,payload_checksum)
      VALUES('workflow-coordinator','${event}','${W}','${sha256(payload)}');
    ${change}
    ${cas ? `UPDATE app.run_checkpoints SET revision=revision+1 WHERE workspace_id='${W}' AND workflow_run_id='${run}';` : ''}
    ${complete ? `UPDATE app.inbox_receipts SET completed_at=clock_timestamp() WHERE consumer_name='workflow-coordinator' AND message_id='${event}';` : ''}`;
}

const refusal = /changed without coordinator authority|not an accepted value/u;
const scenarios = [
  [
    'a fresh worker transaction cannot wipe a finished result',
    (t) => {
      t.refused(`UPDATE app.node_runs SET output_ref=NULL WHERE id='${N}';`);
      t.unchanged();
    },
  ],
  [
    'a fresh worker transaction cannot forge a finished result',
    (t) => {
      t.refused(
        `UPDATE app.node_runs SET output_ref='${forged}' WHERE id='${N}';`,
      );
      t.unchanged();
    },
  ],
  [
    'a fresh worker transaction cannot reopen or fail a finished step',
    (t) => {
      t.refused(
        `UPDATE app.node_runs SET status='failed',output_ref=NULL WHERE id='${N}';`,
      );
      t.refused(`UPDATE app.node_runs SET status='ready' WHERE id='${N}';`);
      t.unchanged();
    },
  ],
  [
    'a fresh worker transaction cannot move the current-attempt pointer',
    (t) => {
      t.refused(
        `UPDATE app.node_runs SET current_attempt_number=7 WHERE id='${N}';`,
      );
      t.refused(
        `UPDATE app.node_runs SET current_attempt_id=NULL,current_attempt_number=NULL WHERE id='${N}';`,
      );
      t.unchanged();
    },
  ],
  [
    'a rolled-back change leaves the result and receipts exactly as they were',
    (t) => {
      const receipts = t.read('SELECT count(*) FROM app.inbox_receipts');
      t.allowed(
        `UPDATE app.node_runs SET output_ref=NULL WHERE id='${N}';`,
        'ROLLBACK',
      );
      t.unchanged();
      assert.equal(t.read('SELECT count(*) FROM app.inbox_receipts'), receipts);
    },
  ],
  [
    're-delivering the same accepted result changes nothing and is allowed',
    (t) => {
      t.allowed(
        `UPDATE app.node_runs SET output_ref='${accepted}',status='succeeded' WHERE id='${N}';`,
      );
      t.unchanged();
    },
  ],
  [
    'the coordinator can still change a finished step in its own transaction',
    (t) => {
      t.allowed(
        coordinator(
          R,
          `UPDATE app.node_runs SET status='failed',output_ref=NULL,safe_error_code='loop_limit_exceeded' WHERE id='${N}';`,
        ),
      );
      assert.equal(t.step(), 'failed|<none>|1');
    },
  ],
  [
    'coordinator proof for a different run does not count',
    (t) => {
      t.refused(
        coordinator(
          OTHER_RUN,
          `UPDATE app.node_runs SET output_ref=NULL WHERE id='${N}';`,
        ),
      );
      t.unchanged();
    },
  ],
  [
    'a receipt without a checkpoint advance does not count',
    (t) => {
      t.refused(
        coordinator(
          R,
          `UPDATE app.node_runs SET output_ref=NULL WHERE id='${N}';`,
          { cas: false },
        ),
      );
      t.unchanged();
    },
  ],
  [
    'a checkpoint advance without a completed receipt does not count',
    (t) => {
      t.refused(
        coordinator(
          R,
          `UPDATE app.node_runs SET output_ref=NULL WHERE id='${N}';`,
          { complete: false },
        ),
      );
      t.unchanged();
    },
  ],
  [
    'the coordinator cannot set a result that is not an accepted value',
    (t) => {
      t.refused(
        coordinator(
          R,
          `UPDATE app.node_runs SET output_ref='${forged}' WHERE id='${N}';`,
        ),
      );
      t.unchanged();
    },
  ],
  [
    'retention may clear a result only after its value is revoked',
    (t) => {
      t.refused(`UPDATE app.node_runs SET output_ref=NULL WHERE id='${N}';`);
      t.owner(
        `UPDATE app.workflow_execution_value_provenance SET eligibility_revoked_at=now() WHERE id='${P}'`,
      );
      t.allowed(`UPDATE app.node_runs SET output_ref=NULL WHERE id='${N}';`);
      assert.equal(t.step(), 'succeeded|<none>|1');
      t.refused(
        `UPDATE app.node_runs SET output_ref='${forged}' WHERE id='${N}';`,
      );
    },
  ],
  [
    'an unfinished native step can only finish with its accepted value',
    (t) => {
      t.owner(`BEGIN; SET LOCAL session_replication_role=replica;
      UPDATE app.node_runs SET status='running',output_ref=NULL,completed_at=NULL WHERE id='${N}'; COMMIT;`);
      t.refused(
        `UPDATE app.node_runs SET status='succeeded',output_ref='${forged}' WHERE id='${N}';`,
      );
      t.allowed(
        `UPDATE app.node_runs SET status='succeeded',output_ref='${accepted}' WHERE id='${N}';`,
      );
      t.unchanged();
    },
  ],
  [
    'steps of non-native runs keep their existing behaviour',
    (t) => {
      t.allowed(
        `UPDATE app.node_runs SET output_ref=NULL WHERE id='${RETAINED}';`,
      );
      t.allowed(
        `UPDATE app.node_runs SET output_ref='${forged}',status='failed' WHERE id='${RETAINED}';`,
      );
    },
  ],
];

function context(container) {
  const read = (sql) => psql(container, sql, 'postgres').trim();
  const step = () =>
    read(
      `SELECT status||'|'||coalesce(output_ref::text,'<none>')||'|'||coalesce(current_attempt_number::text,'-') FROM app.node_runs WHERE id='${N}'`,
    );
  const original = step();
  return {
    read,
    step,
    owner: (sql) => psql(container, sql, 'postgres'),
    unchanged: () => assert.equal(step(), original),
    allowed: (statements, finish) => {
      const error = asWorker(container, statements, finish);
      assert.equal(error, null, error ?? undefined);
    },
    refused: (statements) =>
      assert.match(asWorker(container, statements) ?? 'committed', refusal),
  };
}

const container = execFileSync(
  'docker',
  [
    'run',
    '--rm',
    '-d',
    '--name',
    `pertexo-f08-projection-${randomBytes(4).toString('hex')}`,
    '--label',
    'pertexo.f08.projection-qualification=1',
    '--network',
    'none',
    '--tmpfs',
    '/var/lib/postgresql',
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    '-e',
    'POSTGRES_DB=pertexo_f08',
    'postgres:18-alpine',
  ],
  { encoding: 'utf8' },
).trim();
let failed = 0;
try {
  waitForPostgres(container);
  install(container);
  for (const [name, run] of scenarios) {
    seed(container);
    try {
      run(context(container));
      console.log(`PASS  ${name}`);
    } catch (error) {
      failed += 1;
      console.log(
        `FAIL  ${name}\n      ${String(error.message).split('\n')[0]}`,
      );
    }
  }
  console.log(
    `\n${String(scenarios.length - failed)}/${String(scenarios.length)} scenarios pass`,
  );
} finally {
  execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
}
process.exitCode = failed === 0 ? 0 : 1;
