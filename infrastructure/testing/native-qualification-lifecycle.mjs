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
  const definitions = [
    ...candidate.matchAll(
      /CREATE (?:OR REPLACE )?FUNCTION app\.(\w+)\(([\s\S]*?)\)\s*(RETURNS[\s\S]*?)AS \$\$([\s\S]*?)\$\$;/gu,
    ),
  ];
  const owners = definitions.map((match) => {
    const configuration = match[3].match(
      /\bSET search_path=(pg_catalog,app,pg_temp|pg_catalog,pg_temp)(?: SET row_security=on)?\s*$/u,
    );
    const rowSecurity = match[3].includes('SET row_security=on');
    if (
      !configuration?.[1] ||
      (match[3].match(/\bSET\b/gu)?.length ?? 0) !== (rowSecurity ? 2 : 1)
    )
      throw new Error('Native source function configuration is unknown');
    return {
      signature: `app.${match[1]}(${match[2]
        .replace(/\bp_\w+\s+/gu, '')
        .replace(/char\(64\)/gu, 'character')
        .replace(/varchar\b/gu, 'character varying')
        .replace(/\s+/gu, ' ')
        .trim()
        .replace(/\s*,\s*/gu, ',')})`,
      hash: digest(match[4], 'md5'),
      securityDefiner: match[3].includes('SECURITY DEFINER'),
      rowSecurity,
      proconfig: [
        `search_path=${configuration[1].split(',').join(', ')}`,
        ...(rowSecurity ? ['row_security=on'] : []),
      ],
    };
  });
  if (!isDeepStrictEqual(owners, NATIVE_COORDINATOR_OWNER_INVENTORY))
    throw new Error('Native source and built owner inventory differ');
  const nativeFunctionVolatility = definitions.map((match, index) => {
    const declarations =
      match[3].match(/\b(?:IMMUTABLE|STABLE|VOLATILE)\b/gu) ?? [];
    if (declarations.length > 1)
      throw new Error('Native source function volatility is ambiguous');
    return {
      signature: owners[index].signature,
      // CREATE (OR REPLACE) FUNCTION defaults to VOLATILE when omitted.
      volatility: { IMMUTABLE: 'i', STABLE: 's', VOLATILE: 'v' }[
        declarations[0] ?? 'VOLATILE'
      ],
    };
  });
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
      'infrastructure/postgres/init/10-roles.sh',
      'infrastructure/ecs/validate-runtime-closure.mjs',
      'Dockerfile',
      'packages/database/src/execution/coordinator/coordinator-native-readiness.ts',
      'packages/database/src/platform/readiness-workflow-concurrency.sql.ts',
      'packages/database/src/migrations.ts',
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
    ownerBodyInventorySha256: digest(
      JSON.stringify(
        owners.map((row) => ({
          signature: row.signature,
          hash: row.hash,
          securityDefiner: row.securityDefiner,
          rowSecurity: row.rowSecurity,
        })),
      ),
    ),
    ownerCount: owners.length,
    nativeFunctionVolatility,
    functionVolatilitySha256: digest(JSON.stringify(nativeFunctionVolatility)),
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
  local_json_call: [
    'canonical_publication',
    'canonical_root_acceptance',
    'canonical_call_admission',
    'durable_wait_wakeup_transport',
    'physical_completion',
    'earned_parent_child_facts',
  ],
  // The logical projection fence was merged in 0fa174ad. Selecting these
  // scenarios is no longer excluded; this source assessor still proves no run.
  finalized_output_integrity: [],
  logical_current_result_tampering: [],
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
const excludedCases = new Set(['raw_login_semantic_attestation']);
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

async function observeOwnedResources(
  environment,
  inspect,
  expected,
  unknownIsolation,
) {
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
    const servicePort = id === owned.postgresId ? '5432/tcp' : '6379/tcp';
    if (
      Object.entries(row.NetworkSettings.Ports).some(
        ([port, bindings]) => port !== servicePort && bindings?.length > 0,
      ) ||
      (row.HostConfig !== undefined &&
        (row.HostConfig?.Privileged !== false ||
          typeof row.HostConfig.NetworkMode !== 'string' ||
          row.HostConfig.NetworkMode === '' ||
          row.HostConfig.NetworkMode === 'host' ||
          row.HostConfig.NetworkMode.startsWith('container:')))
    )
      throw new Error('Native fixture network or endpoint isolation differs');
    if (row.HostConfig === undefined)
      unknownIsolation?.push({
        id: `host_configuration_observation:${id}`,
        owner: 'fixture resource observation adapter',
      });
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

function ownerDrift(observed, source) {
  if (!Array.isArray(observed?.nativeFunctions))
    throw new Error('Native catalog observation is unavailable');
  const rows = new Map();
  for (const row of observed.nativeFunctions) {
    if (rows.has(row.signature))
      throw new Error('Native catalog observation contains duplicates');
    rows.set(row.signature, row);
  }
  const differences = [];
  const volatility = new Map(
    source.nativeFunctionVolatility.map((row) => [
      row.signature,
      row.volatility,
    ]),
  );
  for (const expected of NATIVE_COORDINATOR_OWNER_INVENTORY) {
    const row = rows.get(expected.signature);
    if (
      !row ||
      row.hash !== expected.hash ||
      row.securityDefiner !== expected.securityDefiner ||
      row.rowSecurity !== expected.rowSecurity ||
      !isDeepStrictEqual(row.proconfig, expected.proconfig) ||
      row.volatility !== volatility.get(expected.signature) ||
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

const nativeRelations = [
  'app.workflow_calls',
  'app.workflow_execution_value_provenance',
  'app.workflow_execution_value_artifact_candidates',
  'app.workflow_execution_value_artifact_associations',
];
const runtimeRoles = ['pertexo_api', 'pertexo_worker', 'pertexo_dispatcher'];

function catalogRows(rows, names, keys, key = 'name') {
  if (!Array.isArray(rows))
    throw new Error('Malformed compatibility observation');
  const byName = new Map();
  for (const row of rows) {
    if (
      !row ||
      !isDeepStrictEqual(Object.keys(row).sort(), [...keys].sort()) ||
      !names.includes(row[key]) ||
      byName.has(row[key])
    )
      throw new Error(
        'Malformed, duplicate or unknown compatibility observation',
      );
    byName.set(row[key], row);
  }
  return byName;
}

function knownCatalogDrift(catalog, source) {
  const drift = [];
  if (catalog.registeredBase !== undefined) {
    const base = catalog.registeredBase;
    if (
      !base ||
      !isDeepStrictEqual(Object.keys(base).sort(), ['head', 'migrations']) ||
      !Array.isArray(base.migrations)
    )
      throw new Error('Malformed registered base observation');
    catalogRows(
      base.migrations,
      source.migrations.map((row) => row.name),
      ['name', 'sha256'],
    );
    if (
      base.migrations.some(
        (row) =>
          typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.sha256),
      )
    )
      throw new Error('Malformed registered checksum observation');
    if (
      !isDeepStrictEqual(base, {
        head: source.baseHead,
        migrations: source.migrations,
      })
    )
      drift.push('registered_base');
  }
  if (catalog.nativeRelations !== undefined) {
    const rows = catalogRows(catalog.nativeRelations, nativeRelations, [
      'name',
      'owner',
      'rowSecurity',
      'forceRowSecurity',
      'runtimePrivileges',
    ]);
    for (const name of nativeRelations) {
      const row = rows.get(name);
      let denied = false;
      if (row) {
        const privileges = catalogRows(
          row.runtimePrivileges,
          ['PUBLIC', ...runtimeRoles],
          ['role', 'tablePrivileges', 'columnPrivileges'],
          'role',
        );
        denied =
          privileges.size === 4 &&
          [...privileges.values()].every(
            (grants) =>
              isDeepStrictEqual(grants.tablePrivileges, []) &&
              isDeepStrictEqual(grants.columnPrivileges, []),
          );
      }
      if (
        !row ||
        row.owner !== 'pertexo_owner' ||
        row.rowSecurity !== true ||
        row.forceRowSecurity !== true ||
        !denied
      )
        drift.push(`relation:${name}`);
    }
  }
  if (catalog.runtimeRoles !== undefined) {
    const rows = catalogRows(catalog.runtimeRoles, runtimeRoles, [
      'name',
      'superuser',
      'bypassRls',
      'ownerMember',
    ]);
    for (const name of runtimeRoles) {
      if (
        !isDeepStrictEqual(rows.get(name), {
          name,
          superuser: false,
          bypassRls: false,
          ownerMember: false,
        })
      )
        drift.push(`role:${name}`);
    }
  }
  return drift;
}

function compatibilityObservations(catalog, source, unknownIsolation) {
  const missingFacts = [
    {
      id: 'complete_function_acl',
      owner: 'database native readiness / reviewed installation artifact',
    },
    {
      id: 'complete_role_membership_acl_cohort',
      owner: 'role provisioning / fixture installation',
    },
    {
      id: 'qualified_constraints_policies_indexes_triggers',
      owner: 'database published constraint/catalog inventory',
    },
    {
      id: 'full_emitted_process_dependency_manifest',
      owner: 'runtime closure / qualification process manifest',
    },
    {
      id: 'creator_storage_origin_private_network_transport',
      owner: 'fixture resource owner / installation contract',
    },
    ...unknownIsolation,
  ];
  for (const field of ['registeredBase', 'nativeRelations', 'runtimeRoles']) {
    if (catalog[field] === undefined)
      missingFacts.push({
        id: {
          registeredBase: 'registered_base_observation',
          nativeRelations: 'native_relation_observation',
          runtimeRoles: 'runtime_role_observation',
        }[field],
        owner: 'database catalog observation adapter',
      });
  }
  return {
    complete: false,
    dedicatedTargetVerified: false,
    missingFacts,
    drift: knownCatalogDrift(catalog, source),
  };
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
    const unknownIsolation = [];
    const resources = await observeOwnedResources(
      environment,
      inspect,
      expectedResources,
      unknownIsolation,
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
      nativeOwnerDrift: ownerDrift(catalog, source),
      compatibility: compatibilityObservations(
        catalog,
        source,
        unknownIsolation,
      ),
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
