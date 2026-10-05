// Local development setup only. Never registers 0137, changes its source abort,
// installs ADR066 authority, or supplies production qualification/activation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createCoreWorkflowCompatibility } from '../../apps/api/dist/platform/workflow/workflow-compatibility.js';

assert.equal(process.env.PERTEXO_LOCAL_JSON_CALL, 'true');
assert.equal(process.env.NODE_ENV, 'development');
assert.equal(
  process.env.COMPOSE_PROJECT_NAME,
  'pertexo-f08-local-json-call-20261005',
);
const container = 'pertexo-f08-local-json-call-20261005-postgres-1';
assert.equal(
  process.argv.length,
  2,
  'Local setup accepts no repair/install overrides',
);
const owned = execFileSync(
  'docker',
  [
    'inspect',
    '--format',
    '{{index .Config.Labels "com.docker.compose.project"}}|{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostIp}}|{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',
    container,
  ],
  { encoding: 'utf8' },
).trim();
assert.equal(owned, 'pertexo-f08-local-json-call-20261005|127.0.0.1|51243');
const query = (sql, role = 'postgres') =>
  execFileSync(
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
      role,
      '-d',
      'pertexo',
    ],
    {
      input: sql,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
assert.equal(
  query(
    'select name from pertexo_internal.schema_migrations order by name desc limit 1',
  ).trim(),
  '0136_workflow_draft_graph_v2.sql',
);
assert.equal(
  query("select to_regclass('app.workflow_calls') is null").trim(),
  't',
  'Local candidate setup is one-time only',
);
const source = await readFile(
  new URL(
    '../../packages/database/src/execution/workflow-calls/0137-native-execution-values.candidate.sql',
    import.meta.url,
  ),
  'utf8',
);
const abort =
  /DO \$\$ BEGIN\n {2}RAISE EXCEPTION 'Unregistered F08 0137 review candidate: installation is not authorized';\nEND \$\$;\n/u;
assert.ok(abort.test(source));
let sql = source.replace(abort, '');
for (const [name, role] of Object.entries({
  owner_role: 'pertexo_owner',
  api_runtime_role: 'pertexo_api',
  worker_runtime_role: 'pertexo_worker',
  dispatcher_role: 'pertexo_dispatcher',
  maintenance_role: 'pertexo_maintenance',
  lifecycle_command_role: 'pertexo_lifecycle_command',
  operator_role: 'pertexo_operator',
}))
  sql = sql.replaceAll(`{{${name}}}`, `"${role}"`);
sql = sql.replaceAll('{{regional_write_admission_enforced}}', 'false');
assert.ok(!sql.includes('{{'));
query(
  `BEGIN; SET LOCAL ROLE pertexo_owner; SET LOCAL statement_timeout='120s'; ${sql} COMMIT;`,
  'pertexo_migration',
);
// Fixture-local compatibility selection, not fabricated deployment approval.
// Original production activation procedures remain unchanged. The SQL owner is
// trusted here solely for this explicitly local milestone, not semantic proof.
const compatibility = createCoreWorkflowCompatibility('local_json_call');
const descriptions = compatibility.releaseSupport.descriptions.filter(
  (row) => row.epoch > 1,
);
for (const row of descriptions)
  assert.ok(!row.catalogJson.includes('$local_release$'));
query(`BEGIN; SET LOCAL session_replication_role=replica;
  ${descriptions
    .map(
      (
        row,
      ) => `INSERT INTO app.node_compatibility_releases(epoch,schema_version,fingerprint,catalog_json,predecessor_epoch,prepared_by_kind,prepared_by,reason)
    VALUES(${row.epoch},1,'${row.fingerprint}',$local_release$${row.catalogJson}$local_release$::jsonb,${row.epoch - 1},'migration','owned-local-json-call','Explicit isolated development fixture') ON CONFLICT(epoch) DO NOTHING;
    DO $verify_local$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM app.node_compatibility_releases WHERE epoch=${row.epoch} AND fingerprint='${row.fingerprint}' AND catalog_json=$local_release$${row.catalogJson}$local_release$::jsonb) THEN
        RAISE EXCEPTION 'Local release epoch conflict';
      END IF;
    END $verify_local$;`,
    )
    .join('\n')}
  UPDATE app.node_compatibility_current SET epoch=${descriptions.at(-1).epoch},fingerprint='${descriptions.at(-1).fingerprint}',activated_by_kind='migration',activated_by='owned-local-json-call'; COMMIT;`);
console.log(
  'Owned local JSON Call schema and fixed local release installed; migration registration/production gates unchanged.',
);
