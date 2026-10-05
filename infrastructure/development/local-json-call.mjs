// Explicit owned local development repro; never a production qualifier.
// Run after pnpm dev: PERTEXO_LOCAL_JSON_CALL=true node --env-file=.env
// infrastructure/development/local-json-call.mjs
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createCoreWorkflowCompatibility } from '../../apps/api/dist/platform/workflow/workflow-compatibility.js';
import { workflowCallableContractIdentityV1 } from '../../packages/workflow-model/dist/workflow-call-closure.js';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.env.PERTEXO_LOCAL_JSON_CALL, 'true');
assert.equal(process.env.NODE_ENV, 'development');
assert.equal(
  process.env.COMPOSE_PROJECT_NAME,
  'pertexo-f08-local-json-call-20261005',
);
const container = 'pertexo-f08-local-json-call-20261005-postgres-1';
assert.equal(
  execFileSync(
    'docker',
    [
      'inspect',
      '--format',
      '{{index .Config.Labels "com.docker.compose.project"}}',
      container,
    ],
    { encoding: 'utf8' },
  ).trim(),
  process.env.COMPOSE_PROJECT_NAME,
);
const api = 'http://127.0.0.1:51253';
const origin = 'http://127.0.0.1:5173';
const startupDeadline = Date.now() + 20_000;
let apiReady = false;
do {
  try {
    apiReady = (
      await fetch(`${api}/health/ready`, { signal: AbortSignal.timeout(1000) })
    ).ok;
  } catch {
    /* The owned dev process may still be compiling. */
  }
  if (apiReady) break;
  await delay(250);
} while (Date.now() < startupDeadline);
assert.ok(apiReady, 'Owned API must be ready before creating the fixture');
const actor = randomUUID();
const account = randomUUID();
const email = `local-call-${actor}@example.test`;
const password = randomBytes(24).toString('hex');
const requireApi = createRequire(
  new URL('../../apps/api/package.json', import.meta.url),
);
const { hashPassword } = await import(requireApi.resolve('better-auth/crypto'));
const hash = await hashPassword(password);
// Trusted auth fixture only, not a workflow/publication/admission substitute.
// Seed an already verified disposable account to avoid emitting auth-mail links.
execFileSync(
  'docker',
  [
    'exec',
    '-i',
    container,
    'psql',
    '-X',
    '-q',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'postgres',
    '-d',
    'pertexo',
  ],
  {
    input: `BEGIN; INSERT INTO app.users(id,email,display_name,status,email_verified) VALUES('${actor}','${email}','Local Call fixture','active',true);
    INSERT INTO app.auth_accounts(id,account_id,provider_id,user_id,password) VALUES('${account}','${actor}','credential','${actor}','${hash}'); COMMIT;`,
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);
let cookie = '';
let csrf = '';
async function send(method, path, body, headers = {}) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      Origin: origin,
      'content-type': 'application/json',
      ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const value = await response.json();
  if (!response.ok) {
    // Auth values/cookies are never printed. Only workflow problem metadata.
    console.error(
      JSON.stringify({
        boundary: path.includes('workflows') ? 'workflow HTTP' : 'fixture HTTP',
        status: response.status,
        ...(path.includes('workflows') ? { problem: value } : {}),
      }),
    );
    throw new Error(`Local request refused (${response.status})`);
  }
  return { response, value };
}
const signed = await send('POST', '/v1/auth/sign-in/email', {
  email,
  password,
  callbackURL: '/workspaces',
});
const cookies = signed.response.headers
  .getSetCookie()
  .map((value) => value.split(';', 1)[0]);
cookie = cookies.join('; ');
csrf = decodeURIComponent(
  cookies
    .find((value) => value.startsWith('pertexo_csrf='))
    ?.slice('pertexo_csrf='.length) ?? '',
);
assert.ok(cookie && csrf, 'Actual authenticated browser cookies are required');
const workspace = await send(
  'POST',
  '/v1/workspaces',
  { name: 'Local pinned JSON Call', slug: `local-call-${actor.slice(0, 8)}` },
  { 'Idempotency-Key': randomUUID() },
);
const workspaceId = workspace.value.id;
assert.equal(typeof workspaceId, 'string');
const node = (id, key, inputMappings = {}) => ({
  id,
  definition: { key, version: 1 },
  position: { x: 0, y: 0 },
  configVersion: 1,
  config: {},
  inputMappings,
  connectionRefs: {},
});
const releases =
  createCoreWorkflowCompatibility('local_json_call').releaseSupport
    .descriptions;
function selectFixtureRelease(epoch) {
  const release = releases.find((row) => row.epoch === epoch);
  assert.ok(release);
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      container,
      'psql',
      '-X',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'pertexo',
    ],
    {
      input: `BEGIN; SET LOCAL session_replication_role=replica;
      DO $fixture$ BEGIN
        IF NOT EXISTS(SELECT 1 FROM app.node_compatibility_releases WHERE epoch=${epoch} AND fingerprint='${release.fingerprint}' AND catalog_json=$catalog$${release.catalogJson}$catalog$::jsonb) THEN RAISE EXCEPTION 'Fixture release identity mismatch'; END IF;
      END $fixture$;
      UPDATE app.node_compatibility_current SET epoch=${epoch},fingerprint='${release.fingerprint}',activated_by_kind='migration',activated_by='owned-local-json-call'; COMMIT;`,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
}
// Exact retained epoch1 is selected only to author the pre-existing manual
// nodes through HTTP. This does not reactivate manual in the new local catalog.
// No workflow, published version, execution or Call rows are seeded.
const initial = [];
selectFixtureRelease(1);
try {
  for (const name of ['Pinned JSON child', 'JSON Call parent']) {
    const created = await send(
      'POST',
      `/v1/workspaces/${workspaceId}/workflows`,
      { name },
      { 'Idempotency-Key': randomUUID() },
    );
    const id = created.value.workflow.id;
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
      { 'If-Match': created.response.headers.get('etag') },
    );
    initial.push(id);
  }
} finally {
  selectFixtureRelease(4);
}
const [childId, parentId] = initial;
assert.ok(childId && parentId);
const childDraft = await send(
  'GET',
  `/v1/workspaces/${workspaceId}/workflows/${childId}/draft`,
);
const graph = {
  schemaVersion: 2,
  settings: {},
  nodes: [
    node('manual', 'core.manual'),
    node('set', 'core.set', { answer: { kind: 'literal', value: 42 } }),
  ],
  edges: [
    {
      id: 'manual-set',
      source: { nodeId: 'manual', port: 'out' },
      target: { nodeId: 'set', port: 'in' },
    },
  ],
  callable: {
    schemaVersion: 1,
    input: { type: 'object', properties: {}, required: [] },
    result: {
      type: 'object',
      properties: { answer: { type: 'number' } },
      required: ['answer'],
    },
    resultSelector: { kind: 'node_output', nodeId: 'set', path: '$' },
  },
};
const saved = await send(
  'PUT',
  `/v1/workspaces/${workspaceId}/workflows/${childId}/draft`,
  { graph },
  { 'If-Match': childDraft.response.headers.get('etag') },
);
const published = await send(
  'POST',
  `/v1/workspaces/${workspaceId}/workflows/${childId}/publish`,
  {},
  {
    'If-Match': saved.response.headers.get('etag'),
    'Idempotency-Key': randomUUID(),
  },
);
console.log(
  JSON.stringify({
    boundary: 'actual child publication',
    workspaceId,
    childId,
    parentId,
    versionId: published.value.version.id,
    checksum: published.value.version.checksum,
  }),
);
const call = node('call', 'core.workflow_call');
call.config = {
  workflowId: childId,
  versionId: published.value.version.id,
  checksum: published.value.version.checksum,
  callableContractIdentity: workflowCallableContractIdentityV1(graph.callable),
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
    ...graph.callable,
    resultSelector: { kind: 'node_output', nodeId: 'call', path: '$' },
  },
};
const parentDraft = await send(
  'GET',
  `/v1/workspaces/${workspaceId}/workflows/${parentId}/draft`,
);
const parentSaved = await send(
  'PUT',
  `/v1/workspaces/${workspaceId}/workflows/${parentId}/draft`,
  { graph: parentGraph },
  { 'If-Match': parentDraft.response.headers.get('etag') },
);
const parentPublished = await send(
  'POST',
  `/v1/workspaces/${workspaceId}/workflows/${parentId}/publish`,
  {},
  {
    'If-Match': parentSaved.response.headers.get('etag'),
    'Idempotency-Key': randomUUID(),
  },
);
// Enable the existing checked-manual feature only in this owned fixture. Its
// serialized-writer fence and ordinary rollout guard remain enforced.
execFileSync(
  'docker',
  [
    'exec',
    '-i',
    container,
    'psql',
    '-X',
    '-q',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'postgres',
    '-d',
    'pertexo',
  ],
  {
    input: `BEGIN; SET LOCAL ROLE pertexo_owner;
    DO $checked_manual$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='app.workflow_runs'::regclass AND tgname='manual_start_writer_fence' AND tgenabled='O' AND tgfoid='app.enforce_manual_start_writer()'::regprocedure AND NOT tgisinternal) THEN RAISE EXCEPTION 'Checked manual writer fence unavailable'; END IF;
    END $checked_manual$;
    UPDATE app.workflow_input_case_rollout SET enabled=true WHERE singleton;
    SELECT app.assert_workflow_input_cases_enabled(); COMMIT;`,
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);
const started = await send(
  'POST',
  `/v1/workspaces/${workspaceId}/workflows/${parentId}/runs`,
  { input: {}, expectedPublishedVersionId: parentPublished.value.version.id },
  { 'Idempotency-Key': randomUUID() },
);
const runId = started.value.run.id;
console.log(
  JSON.stringify({
    boundary: 'actual parent acceptance',
    runId,
    parentVersionId: parentPublished.value.version.id,
  }),
);
let details;
const observed = new Set();
const deadline = Date.now() + 30_000;
do {
  details = (await send('GET', `/v1/workspaces/${workspaceId}/runs/${runId}`))
    .value;
  observed.add(details.run.status);
  if (!['queued', 'running', 'waiting'].includes(details.run.status)) break;
  await delay(250);
} while (Date.now() < deadline);
console.log(
  JSON.stringify({
    boundary: 'actual parent execution',
    runId,
    status: details.run.status,
    observed: [...observed],
    callFamily: details.callFamily,
    nodes: details.nodes,
  }),
);
assert.equal(
  details.run.status,
  'succeeded',
  'Actual parent must complete successfully',
);
assert.equal(details.callFamily.children.length, 1);
const childRunId = details.callFamily.children[0].runId;
const childDetails = (
  await send('GET', `/v1/workspaces/${workspaceId}/runs/${childRunId}`)
).value;
assert.equal(childDetails.run.status, 'succeeded');
assert.equal(childDetails.callFamily.parentRunId, runId);
const facts = JSON.parse(
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
      'postgres',
      '-d',
      'pertexo',
    ],
    {
      input: `SELECT jsonb_build_object('parent',parent.output_ref,'child',child.output_ref,'pinVersion',call.callee_workflow_version_id,'outcome',call.outcome_kind)
    FROM app.workflow_calls call JOIN app.workflow_runs parent ON parent.id=call.parent_run_id
    JOIN app.workflow_runs child ON child.id=call.child_run_id WHERE parent.id='${runId}' AND child.id='${childRunId}';`,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  ).trim(),
);
assert.equal(facts.pinVersion, published.value.version.id);
assert.deepEqual(facts.parent.value, { answer: 42 });
assert.deepEqual(facts.child.value, { answer: 42 });
assert.equal(facts.outcome, 'admitted');
assert.ok(observed.has('waiting'), 'Real parent must wait for its child');
// Negative owner-policy checks use the real delivery receipt. A disposable
// other-consumer receipt is inserted only inside this rolled-back test.
execFileSync(
  'docker',
  [
    'exec',
    '-i',
    container,
    'psql',
    '-X',
    '-q',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'postgres',
    '-d',
    'pertexo',
  ],
  {
    input: `BEGIN;
    INSERT INTO app.inbox_receipts(workspace_id,consumer_name,message_id,payload_checksum) VALUES('${workspaceId}','local-unrelated-consumer','${randomUUID()}','${'0'.repeat(64)}');
    SET LOCAL ROLE pertexo_owner;
    SELECT set_config('app.workspace_id','${workspaceId}',true);
    DO $receipt_boundary$ DECLARE v_message uuid; v_count integer; BEGIN
      SELECT receipt.message_id INTO v_message FROM app.inbox_receipts receipt JOIN app.outbox_events event ON event.id=receipt.message_id
        WHERE receipt.consumer_name='node-attempt-worker' AND event.payload->>'runId'='${runId}' LIMIT 1;
      IF v_message IS NULL THEN RAISE EXCEPTION 'Actual native attempt receipt unavailable'; END IF;
      PERFORM 1 FROM app.inbox_receipts WHERE message_id=v_message AND consumer_name='node-attempt-worker' FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Native receipt lock unavailable'; END IF;
      IF EXISTS(SELECT 1 FROM app.inbox_receipts WHERE consumer_name='local-unrelated-consumer') THEN RAISE EXCEPTION 'Other consumer visible'; END IF;
      BEGIN
        UPDATE app.inbox_receipts SET completed_at=completed_at WHERE message_id=v_message AND consumer_name='node-attempt-worker';
        RAISE EXCEPTION 'Owner receipt mutation unexpectedly permitted';
      EXCEPTION WHEN insufficient_privilege THEN NULL; END;
      PERFORM set_config('app.workspace_id','${randomUUID()}',true);
      SELECT count(*) INTO v_count FROM app.inbox_receipts WHERE message_id=v_message;
      IF v_count<>0 THEN RAISE EXCEPTION 'Cross-workspace receipt visible'; END IF;
    END $receipt_boundary$; ROLLBACK;`,
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);
console.log(
  JSON.stringify({
    boundary: 'local parent-child JSON milestone',
    runId,
    childRunId,
    facts,
  }),
);
