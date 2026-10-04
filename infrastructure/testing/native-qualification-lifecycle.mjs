import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { verifyCuratedFixtureOwnership } from './curated-template-owned-fixture.mjs';
import { NATIVE_COORDINATOR_OWNER_INVENTORY } from '../../packages/database/dist/execution/coordinator/coordinator-native-owner-inventory.js';
import { NATIVE_PUBLISHED_CONSTRAINT_INVENTORY } from '../../packages/database/dist/execution/coordinator/coordinator-native-published-constraints.js';

const repository = new URL('../../', import.meta.url);
const execute = promisify(execFile);
const candidatePath =
  'packages/database/src/execution/workflow-calls/0137-native-execution-values.candidate.sql';
const digest = (bytes, algorithm = 'sha256') =>
  createHash(algorithm).update(bytes).digest('hex');

/** Actual fixed-path reads only. Never reads quarantined0136 or executes SQL. */
export async function observeNativeQualificationSource() {
  const { stdout } = await execute(
    'git',
    ['rev-parse', 'HEAD', 'HEAD^{tree}'],
    { cwd: fileURLToPath(repository) },
  );
  const [commit, tree] = stdout.trim().split('\n');
  const candidate = await readFile(new URL(candidatePath, repository), 'utf8');
  const owners = [
    ...candidate.matchAll(
      /CREATE (?:OR REPLACE )?FUNCTION app\.(\w+)\(([\s\S]*?)\)\s*(RETURNS[\s\S]*?)AS \$\$([\s\S]*?)\$\$;/gu,
    ),
  ].map((match) => ({
    signature: `app.${match[1]}(${match[2]
      .replace(/\bp_\w+\s+/gu, '')
      .replace(/char\(64\)/gu, 'character')
      .replace(/varchar\b/gu, 'character varying')
      .replace(/\s+/gu, ' ')
      .trim()
      .replace(/\s*,\s*/gu, ',')})`,
    hash: digest(match[4], 'md5'),
    securityDefiner: match[3].includes('SECURITY DEFINER'),
    rowSecurity: match[3].includes('SET row_security=on'),
  }));
  if (!isDeepStrictEqual(owners, NATIVE_COORDINATOR_OWNER_INVENTORY))
    throw new Error('Native source and built owner inventory differ');
  const names = (
    await readdir(new URL('packages/database/migrations/', repository))
  )
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
    .sort();
  const migrations = await Promise.all(
    names.map(async (name) => ({
      name,
      sha256: digest(
        await readFile(
          new URL(`packages/database/migrations/${name}`, repository),
        ),
      ),
    })),
  );
  const artifacts = await Promise.all(
    [
      'infrastructure/testing/native-qualification-lifecycle.mjs',
      'packages/database/src/execution/coordinator/coordinator-native-owner-inventory.ts',
      'packages/database/src/execution/coordinator/coordinator-native-published-constraints.ts',
      'packages/database/dist/execution/coordinator/coordinator-native-owner-inventory.js',
      'packages/database/dist/execution/coordinator/coordinator-native-published-constraints.js',
    ].map(async (path) => ({
      path,
      sha256: digest(await readFile(new URL(path, repository))),
    })),
  );
  return Object.freeze({
    commit,
    tree,
    candidateSha256: digest(candidate),
    ownerInventorySha256: digest(JSON.stringify(owners)),
    ownerCount: owners.length,
    baseHead: names.at(-1),
    migrations,
    artifacts,
    installationGuardPresent:
      /^DO \$\$ BEGIN\s+RAISE EXCEPTION 'Unregistered F08 0137 review candidate: installation is not authorized';\s+END \$\$;/mu.test(
        candidate,
      ) &&
      candidate.indexOf("RAISE EXCEPTION 'Unregistered F08 0137") <
        candidate.indexOf('ALTER TABLE'),
    publishedConstraintQualified: NATIVE_PUBLISHED_CONSTRAINT_INVENTORY.every(
      (row) => row.qualifiedExpressionMd5 !== null,
    ),
  });
}

const functionalCases = Object.freeze({
  call_wait_resume: [
    'adr066_semantic_authority',
    'canonical_publication',
    'canonical_root_acceptance',
    'canonical_call_admission',
    'durable_wait_wakeup_transport',
  ],
  parallel_control_reconciliation: [
    'canonical_publication',
    'canonical_root_acceptance',
    'physical_completion',
    'authenticated_controls_clock',
  ],
  artifact_result_lifetime: [
    'adr066_semantic_authority',
    'canonical_publication',
    'canonical_root_acceptance',
    'artifact_preparation_association_result_quota',
  ],
  retention_family_resume: [
    'earned_parent_child_facts',
    'native_detail_summary_purge_hold',
  ],
});
const excludedCases = new Set([
  'finalized_output_integrity',
  'logical_current_result_tampering',
  'raw_login_semantic_attestation',
]);
// Concrete current implementation gaps, not caller-supplied approval flags.
const runtimeBlockers = Object.freeze([
  'installation_artifact_unavailable',
  'canonical_admission_unavailable',
  'adr066_integration_unavailable',
  'installed_manifest_unreviewed',
  'emitted_process_manifest_unreviewed',
  'nonserving_isolation_unreviewed',
  'artifact_transport_manifest_unavailable',
  'runtime_case_scope_unapproved',
]);

function selectedCases(ids) {
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    new Set(ids).size !== ids.length
  )
    throw new Error('A nonempty unique functional case selection is required');
  for (const id of ids) {
    if (excludedCases.has(id))
      throw new Error('Excluded qualification campaign cannot be selected');
    if (!Object.hasOwn(functionalCases, id))
      throw new Error('Unknown native functional case');
  }
  return ids.map((id) => ({ id, unclosedOwners: [...functionalCases[id]] }));
}

async function observeOwnedResources(environment, inspect, expected) {
  const inspections = new Map();
  const owned = await verifyCuratedFixtureOwnership(environment, async (id) => {
    const text = await inspect(id);
    inspections.set(id, JSON.parse(text)[0]);
    return text;
  });
  const current = Object.fromEntries(
    Object.keys(expected).map((key) => [key, owned[key]]),
  );
  if (
    !isDeepStrictEqual(current, expected) ||
    !/^pertexo-f08-qualification-[a-z0-9-]+$/u.test(owned.project)
  )
    throw new Error('Native fixture resource identity differs');
  if (owned.postgresId === owned.redisId)
    throw new Error('Native fixture instances must be distinct');
  for (const id of [owned.postgresId, owned.redisId]) {
    const row = inspections.get(id);
    if (
      row.Config.Labels['io.pertexo.fixture-purpose'] !==
        'f08-native-qualification' ||
      !Array.isArray(row.Mounts) ||
      row.Mounts.length === 0 ||
      row.Mounts.some((mount) => mount.Type !== 'tmpfs')
    )
      throw new Error(
        'Native qualification requires purpose-owned disposable storage',
      );
  }
  return Object.freeze(current);
}

function ownerDrift(observed) {
  if (!Array.isArray(observed?.nativeFunctions))
    throw new Error('Native catalog observation is unavailable');
  const rows = new Map();
  for (const row of observed.nativeFunctions) {
    if (rows.has(row.signature))
      throw new Error('Native catalog observation contains duplicates');
    rows.set(row.signature, row);
  }
  const differences = [];
  for (const expected of NATIVE_COORDINATOR_OWNER_INVENTORY) {
    const row = rows.get(expected.signature);
    if (
      !row ||
      row.hash !== expected.hash ||
      row.securityDefiner !== expected.securityDefiner ||
      row.rowSecurity !== expected.rowSecurity ||
      row.owner !== 'pertexo_owner'
    )
      differences.push(expected.signature);
    rows.delete(expected.signature);
  }
  if (rows.size)
    throw new Error('Native catalog observation contains unexpected functions');
  return differences;
}

function verifyDisposal(rows, resources) {
  const ids = [resources.postgresId, resources.redisId].sort();
  if (
    !Array.isArray(rows) ||
    rows.length !== ids.length ||
    !isDeepStrictEqual(rows.map((row) => row?.id).sort(), ids) ||
    rows.some((row) => row.exists !== false)
  )
    throw new Error('Exact owned resource absence was not confirmed');
}

/** Source-only assessor and joined ownership disposal. No installer/case executor. */
export function createNativeQualificationLifecycle(input) {
  const resourceKeys = [
    'postgresId',
    'postgresPort',
    'project',
    'redisId',
    'redisPort',
  ];
  if (
    !input.expectedResources ||
    !isDeepStrictEqual(
      Object.keys(input.expectedResources).sort(),
      resourceKeys,
    ) ||
    ![
      input.expectedResources.postgresId,
      input.expectedResources.redisId,
    ].every((id) => typeof id === 'string' && /^[a-f0-9]{64}$/u.test(id)) ||
    ![
      input.expectedResources.postgresPort,
      input.expectedResources.redisPort,
    ].every(
      (port) => Number.isInteger(port) && port >= 1024 && port <= 65535,
    ) ||
    typeof input.expectedResources.project !== 'string'
  )
    throw new Error('Exact native fixture resource bindings are required');
  for (const name of [
    'inspect',
    'observeCatalog',
    'joinApplication',
    'disposeResources',
    'observeDisposal',
  ])
    if (typeof input[name] !== 'function')
      throw new Error(
        'Explicit qualification observation/cleanup adapters are required',
      );
  const expectedSource = structuredClone(input.source);
  const expectedResources = structuredClone(input.expectedResources);
  const environment = structuredClone(input.environment);
  const {
    inspect,
    observeCatalog,
    joinApplication,
    disposeResources,
    observeDisposal,
  } = input;
  const controller = new AbortController();
  const pending = new Set();
  let state = 'blocked_before_install',
    closing;
  const checkOpen = () => controller.signal.throwIfAborted();
  async function assess(ids) {
    checkOpen();
    const cases = selectedCases(ids);
    const source = await observeNativeQualificationSource();
    checkOpen();
    if (!isDeepStrictEqual(source, expectedSource))
      throw new Error('Native qualification source/build binding drifted');
    const resources = await observeOwnedResources(
      environment,
      inspect,
      expectedResources,
    );
    checkOpen();
    const catalog = await observeCatalog(controller.signal);
    checkOpen();
    return Object.freeze({
      state,
      nativeReady: false,
      runtimeStartAuthorized: false,
      installedCompatible: false,
      evidence: 'source_and_injected_observations',
      source,
      resources,
      cases,
      nativeOwnerDrift: ownerDrift(catalog),
      blockers: [...runtimeBlockers],
    });
  }
  async function dispose() {
    // Stop admission synchronously before joining any outstanding observation.
    controller.abort(new Error('Native source lifecycle is closing'));
    await Promise.allSettled([...pending]);
    try {
      await joinApplication();
      const resources = await observeOwnedResources(
        environment,
        inspect,
        expectedResources,
      );
      await disposeResources(resources);
      verifyDisposal(await observeDisposal(resources), expectedResources);
      state = 'disposed';
    } catch (error) {
      state = 'cleanup_failed';
      throw new AggregateError(
        [error],
        'Native fixture cleanup failed; disposal is unconfirmed',
      );
    }
  }
  return Object.freeze({
    get state() {
      return state;
    },
    async assess(ids) {
      const work = assess(ids);
      pending.add(work);
      try {
        return await work;
      } finally {
        pending.delete(work);
      }
    },
    close() {
      if (!closing) {
        const completion = Promise.withResolvers();
        // Publish before abort listeners can reenter; dispose still stops admission now.
        closing = completion.promise;
        void dispose().then(completion.resolve, completion.reject);
      }
      return closing;
    },
  });
}
