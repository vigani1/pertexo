import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  createNativeQualificationLifecycle,
  observeNativeQualificationSource,
} from './native-qualification-lifecycle.mjs';
import { NATIVE_COORDINATOR_OWNER_INVENTORY } from '../../packages/database/dist/execution/coordinator/coordinator-native-owner-inventory.js';

// Source-only behavior; no SQL, Docker inspection or runtime fixture execution.
test('binds the actual guarded candidate and exact native inventory without qualifying installation', async () => {
  const observed = await observeNativeQualificationSource();
  assert.equal(
    observed.candidateSha256,
    '45dcedde7f382b54978578d3f6f8aba066b7a58e1b874e11e65bda90ea67c6bd',
  );
  assert.equal(observed.ownerCount, 70);
  assert.equal(
    observed.ownerInventorySha256,
    '4f01ec853699e8d2e26ad3613fa963395311592c7f442b86a0a2598dc78b43a4',
  );
  assert.equal(
    observed.ownerBodyInventorySha256,
    '38d78e0340bb875b8bbf42fe97269c9a9e8b162d3fd6ab7cda7815e622818026',
  );
  // The reviewed baseline plus exactly these later additions: the run-family
  // reader and the step logical-projection guard with its accepted-value lookup.
  const additions = new Set([
    'app.read_workflow_call_run_family(uuid)',
    'app.native_node_accepted_output(uuid,uuid,uuid,character varying,uuid,jsonb)',
    'app.check_native_node_logical_projection()',
  ]);
  const previousOwners = NATIVE_COORDINATOR_OWNER_INVENTORY.filter(
    (row) => !additions.has(row.signature),
  );
  assert.equal(previousOwners.length, 67);
  assert.equal(
    createHash('sha256').update(JSON.stringify(previousOwners)).digest('hex'),
    'f70c0d100e7d15970f3e57233d0df6b4a8410cf67b2f9ac9ade019d2c1a1f4fa',
  );
  assert.equal(observed.installationGuardPresent, true);
  assert.equal(
    createHash('sha256')
      .update(
        JSON.stringify(
          previousOwners.map((row) => ({
            signature: row.signature,
            hash: row.hash,
            securityDefiner: row.securityDefiner,
            rowSecurity: row.rowSecurity,
          })),
        ),
      )
      .digest('hex'),
    'e709b9b825a659cde0e25bf0936804be8c65fedf5565cdd0434e57e023aab85b',
  );
  assert.equal(observed.baseHead, '0136_workflow_draft_graph_v2.sql');
  assert.equal(observed.publishedConstraintQualified, false);
});

function simulatedFixture(source) {
  const manifest = {
    project: 'pertexo-f08-qualification-unit',
    postgres: { id: 'a'.repeat(64), port: 55461 },
    redis: { id: 'b'.repeat(64), port: 56391 },
  };
  const environment = {
    EDITOR_BROWSER_OWNED_FIXTURE: 'true',
    EDITOR_BROWSER_OWNERSHIP_MANIFEST: JSON.stringify(manifest),
    REDIS_URL: 'redis://:synthetic@127.0.0.1:56391/0',
  };
  for (const [name, role] of [
    ['ADMIN', 'postgres'],
    ['MIGRATION', 'pertexo_migration'],
    ['API', 'pertexo_api'],
    ['WORKER', 'pertexo_worker'],
    ['DISPATCHER', 'pertexo_dispatcher'],
  ])
    environment[`DATABASE_${name}_URL`] =
      `postgresql://${role}:synthetic@127.0.0.1:55461/${name === 'ADMIN' ? 'postgres' : 'pertexo'}`;
  const rows = new Map(
    [manifest.postgres, manifest.redis].map((resource, index) => [
      resource.id,
      {
        Id: resource.id,
        State: { Running: true },
        Config: {
          Labels: {
            'com.docker.compose.project': manifest.project,
            'io.pertexo.fixture-purpose': 'f08-native-qualification',
          },
        },
        Mounts: [{ Type: 'tmpfs' }],
        NetworkSettings: {
          Ports: {
            [index === 0 ? '5432/tcp' : '6379/tcp']: [
              { HostIp: '127.0.0.1', HostPort: String(resource.port) },
            ],
          },
        },
      },
    ]),
  );
  const disposed = [];
  return {
    source,
    environment,
    expectedResources: {
      project: manifest.project,
      postgresId: manifest.postgres.id,
      redisId: manifest.redis.id,
      postgresPort: 55461,
      redisPort: 56391,
    },
    inspect: async (id) => JSON.stringify([rows.get(id)]),
    observeCatalog: async () => ({ nativeFunctions: [] }),
    joinApplication: async () => undefined,
    disposeResources: async (resources) => {
      disposed.push(resources);
      rows.delete(resources.postgresId);
      rows.delete(resources.redisId);
    },
    observeDisposal: async (resources) =>
      [resources.postgresId, resources.redisId].map((id) => ({
        id,
        exists: rows.has(id),
      })),
    rows,
    disposed,
  };
}

function simulatedNativeFunctions(source) {
  return NATIVE_COORDINATOR_OWNER_INVENTORY.map((row) => ({
    ...row,
    owner: 'pertexo_owner',
    volatility: source.nativeFunctionVolatility.find(
      (profile) => profile.signature === row.signature,
    )?.volatility,
  }));
}

test('source lifecycle reports exact drift and runtime prerequisites without creating admission', async () => {
  const source = await observeNativeQualificationSource();
  const input = simulatedFixture(source);
  const owner = createNativeQualificationLifecycle(input);
  const report = await owner.assess(['call_wait_resume']);
  assert.equal(report.state, 'blocked_before_install');
  assert.equal(report.nativeReady, false);
  assert.equal(report.runtimeStartAuthorized, false);
  assert.ok(report.blockers.includes('installation_artifact_unavailable'));
  assert.ok(report.blockers.includes('canonical_admission_unavailable'));
  assert.ok(report.blockers.includes('adr066_integration_unavailable'));
  assert.equal(report.nativeOwnerDrift.length, 70);
  assert.equal(report.evidence, 'source_and_injected_observations');
  await owner.close();
  assert.equal(input.disposed.length, 1);
  assert.equal(owner.state, 'disposed');
});

test('rejects a partial caller ownership selector before inspection or cleanup', async () => {
  const input = simulatedFixture(await observeNativeQualificationSource());
  input.expectedResources = {};
  assert.throws(
    () => createNativeQualificationLifecycle(input),
    /Exact native fixture resource bindings/u,
  );
  assert.equal(input.disposed.length, 0);
});

test('does not declare disposal when the simulated resource still exists', async () => {
  const input = simulatedFixture(await observeNativeQualificationSource());
  input.disposeResources = async () => undefined;
  const owner = createNativeQualificationLifecycle(input);
  await assert.rejects(owner.close(), /cleanup failed/u);
  assert.equal(owner.state, 'cleanup_failed');
});

test('rejects source drift before catalog observations', async () => {
  const input = simulatedFixture(await observeNativeQualificationSource());
  input.source = { ...input.source, candidateSha256: '0'.repeat(64) };
  let observed = false;
  input.observeCatalog = async () => {
    observed = true;
    return { nativeFunctions: [] };
  };
  const owner = createNativeQualificationLifecycle(input);
  await assert.rejects(owner.assess(['call_wait_resume']), /binding drifted/u);
  assert.equal(observed, false);
  await owner.close();
});

test('rejects excluded, unknown and duplicate cases before any resource observations', async () => {
  const input = simulatedFixture(await observeNativeQualificationSource());
  let inspected = false;
  const inspect = input.inspect;
  input.inspect = async (id) => {
    inspected = true;
    return inspect(id);
  };
  const owner = createNativeQualificationLifecycle(input);
  for (const ids of [
    ['finalized_output_integrity'],
    ['logical_current_result_tampering'],
    ['raw_login_semantic_attestation'],
    ['other'],
    [],
    ['call_wait_resume', 'call_wait_resume'],
  ])
    await assert.rejects(owner.assess(ids));
  assert.equal(inspected, false);
  await owner.close();
});

test('joins a late catalog observation before disposal and rejects its result after close', async () => {
  const input = simulatedFixture(await observeNativeQualificationSource());
  const entered = Promise.withResolvers();
  const reply = Promise.withResolvers();
  input.observeCatalog = async (signal) => {
    entered.resolve(signal);
    return reply.promise;
  };
  const owner = createNativeQualificationLifecycle(input);
  const assessment = assert.rejects(
    owner.assess(['call_wait_resume']),
    /closing/u,
  );
  const signal = await entered.promise;
  const closing = owner.close();
  assert.equal(signal.aborted, true);
  assert.equal(input.disposed.length, 0);
  assert.equal(owner.close(), closing);
  reply.resolve({ nativeFunctions: [] });
  await assessment;
  await closing;
  assert.equal(input.disposed.length, 1);
  await assert.rejects(owner.assess(['call_wait_resume']), /closing/u);
});

test('reentrant close during abort shares one joined cleanup and stops admission synchronously', async () => {
  const input = simulatedFixture(await observeNativeQualificationSource());
  const entered = Promise.withResolvers();
  const reply = Promise.withResolvers();
  const counts = { join: 0, dispose: 0, absence: 0 };
  for (const [name, counter] of [
    ['joinApplication', 'join'],
    ['disposeResources', 'dispose'],
    ['observeDisposal', 'absence'],
  ]) {
    const adapter = input[name];
    input[name] = async (...args) => {
      counts[counter]++;
      return adapter(...args);
    };
  }
  let reentrant, denied;
  // The owner snapshots adapters, so register the abort boundary before construction.
  const catalogInput = {
    ...input,
    observeCatalog: async (signal) => {
      signal.addEventListener(
        'abort',
        () => {
          reentrant = lifecycle.close();
          denied = assert.rejects(
            lifecycle.assess(['call_wait_resume']),
            /closing/u,
          );
        },
        { once: true },
      );
      entered.resolve(signal);
      return reply.promise;
    },
  };
  const lifecycle = createNativeQualificationLifecycle(catalogInput);
  const assessment = assert.rejects(
    lifecycle.assess(['call_wait_resume']),
    /closing/u,
  );
  const signal = await entered.promise;
  const closing = lifecycle.close();
  assert.equal(signal.aborted, true);
  assert.deepEqual(counts, { join: 0, dispose: 0, absence: 0 });
  reply.resolve({ nativeFunctions: [] });
  const outcomes = await Promise.allSettled([
    closing,
    reentrant,
    assessment,
    denied,
  ]);
  assert.equal(reentrant, closing);
  assert.ok(outcomes.every((outcome) => outcome.status === 'fulfilled'));
  assert.deepEqual(counts, { join: 1, dispose: 1, absence: 1 });
  assert.equal(lifecycle.state, 'disposed');
});

test('failed application join retains resources and preserves the cleanup cause', async () => {
  const input = simulatedFixture(await observeNativeQualificationSource());
  const failure = new Error('simulated process did not join');
  input.joinApplication = async () => {
    throw failure;
  };
  const owner = createNativeQualificationLifecycle(input);
  await assert.rejects(
    owner.close(),
    (error) => error instanceof AggregateError && error.errors[0] === failure,
  );
  assert.equal(owner.state, 'cleanup_failed');
  assert.equal(input.disposed.length, 0);
});

test('rechecks ownership after joining before destructive cleanup', async () => {
  const input = simulatedFixture(await observeNativeQualificationSource());
  input.joinApplication = async () => {
    input.rows.get(input.expectedResources.postgresId).Config.Labels[
      'com.docker.compose.project'
    ] = 'unrelated';
  };
  const owner = createNativeQualificationLifecycle(input);
  await assert.rejects(owner.close(), /cleanup failed/u);
  assert.equal(input.disposed.length, 0);
});

test('requires exact unique resource absence observations', async () => {
  for (const rows of [
    [],
    [
      { id: 'c'.repeat(64), exists: false },
      { id: 'd'.repeat(64), exists: false },
    ],
    [
      { id: 'a'.repeat(64), exists: false },
      { id: 'a'.repeat(64), exists: false },
    ],
  ]) {
    const input = simulatedFixture(await observeNativeQualificationSource());
    input.observeDisposal = async () => rows;
    const owner = createNativeQualificationLifecycle(input);
    await assert.rejects(owner.close(), /cleanup failed/u);
    assert.equal(owner.state, 'cleanup_failed');
  }
});

test('rejects shared, stopped, purpose-mismatched and nondisposable resource simulations', async () => {
  const changes = [
    (row) => {
      row.State.Running = false;
    },
    (row) => {
      row.Config.Labels['io.pertexo.fixture-purpose'] = 'ordinary-serving';
    },
    (row) => {
      row.Mounts = [{ Type: 'bind' }];
    },
    (row) => {
      row.NetworkSettings.Ports['5432/tcp'][0].HostIp = '0.0.0.0';
    },
  ];
  for (const change of changes) {
    const input = simulatedFixture(await observeNativeQualificationSource());
    change(input.rows.get(input.expectedResources.postgresId));
    let observed = false;
    input.observeCatalog = async () => {
      observed = true;
      return { nativeFunctions: [] };
    };
    const owner = createNativeQualificationLifecycle(input);
    await assert.rejects(owner.assess(['call_wait_resume']));
    assert.equal(observed, false);
    await assert.rejects(owner.close(), /cleanup failed/u);
    assert.equal(input.disposed.length, 0);
  }
});

test('all four functional selections remain blocked even with matching simulated function profiles', async () => {
  const input = simulatedFixture(await observeNativeQualificationSource());
  input.observeCatalog = async () => ({
    nativeFunctions: simulatedNativeFunctions(input.source),
  });
  const owner = createNativeQualificationLifecycle(input);
  const report = await owner.assess([
    'call_wait_resume',
    'parallel_control_reconciliation',
    'artifact_result_lifetime',
    'retention_family_resume',
  ]);
  assert.equal(report.cases.length, 4);
  assert.ok(report.cases.every((row) => row.unclosedOwners.length > 0));
  assert.deepEqual(report.nativeOwnerDrift, []);
  assert.equal(report.installedCompatible, false);
  assert.equal(report.nativeReady, false);
  assert.equal(report.runtimeStartAuthorized, false);
  assert.ok(report.blockers.includes('installed_manifest_unreviewed'));
  await owner.close();
});

test('duplicate and unexpected catalog rows cannot pass the partial profile observation', async () => {
  for (const nativeFunctions of [
    [{ signature: 'app.other()' }],
    [{ signature: 'app.other()' }, { signature: 'app.other()' }],
  ]) {
    const input = simulatedFixture(await observeNativeQualificationSource());
    input.observeCatalog = async () => ({ nativeFunctions });
    const owner = createNativeQualificationLifecycle(input);
    await assert.rejects(
      owner.assess(['parallel_control_reconciliation']),
      /unexpected functions|duplicates/u,
    );
    await owner.close();
  }
});

test('snapshots caller source and resource bindings rather than adopting later mutations', async () => {
  const input = simulatedFixture(await observeNativeQualificationSource());
  input.source = structuredClone(input.source);
  const owner = createNativeQualificationLifecycle(input);
  input.source.candidateSha256 = '0'.repeat(64);
  input.expectedResources.postgresId = 'c'.repeat(64);
  input.environment.EDITOR_BROWSER_OWNERSHIP_MANIFEST = '{}';
  const report = await owner.assess(['artifact_result_lifetime']);
  assert.equal(
    report.source.candidateSha256,
    '45dcedde7f382b54978578d3f6f8aba066b7a58e1b874e11e65bda90ea67c6bd',
  );
  assert.equal(report.resources.postgresId, 'a'.repeat(64));
  assert.equal(Object.isFrozen(report.resources), true);
  await owner.close();
});

test('unknown installed and isolation facts remain explicit owned blockers', async () => {
  const input = simulatedFixture(await observeNativeQualificationSource());
  const owner = createNativeQualificationLifecycle(input);
  const report = await owner.assess(['call_wait_resume']);
  assert.equal(report.compatibility.complete, false);
  assert.equal(report.compatibility.dedicatedTargetVerified, false);
  assert.ok(
    report.compatibility.missingFacts.some(
      (row) => row.id === 'registered_base_observation',
    ),
  );
  assert.ok(
    report.compatibility.missingFacts.some(
      (row) => row.id === 'qualified_constraints_policies_indexes_triggers',
    ),
  );
  assert.ok(
    report.compatibility.missingFacts.every((row) => row.owner.length > 0),
  );
  await owner.close();
});

function simulatedInstalledCatalog(source) {
  return {
    nativeFunctions: [],
    registeredBase: {
      head: source.baseHead,
      migrations: structuredClone(source.migrations),
    },
    nativeRelations: [
      'app.workflow_calls',
      'app.workflow_execution_value_provenance',
      'app.workflow_execution_value_artifact_candidates',
      'app.workflow_execution_value_artifact_associations',
    ].map((name) => ({
      name,
      owner: 'pertexo_owner',
      rowSecurity: true,
      forceRowSecurity: true,
      runtimePrivileges: [
        'PUBLIC',
        'pertexo_api',
        'pertexo_worker',
        'pertexo_dispatcher',
      ].map((role) => ({ role, tablePrivileges: [], columnPrivileges: [] })),
    })),
    runtimeRoles: ['pertexo_api', 'pertexo_worker', 'pertexo_dispatcher'].map(
      (name) => ({
        name,
        superuser: false,
        bypassRls: false,
        ownerMember: false,
      }),
    ),
  };
}

test('retains independently bound base, forced-RLS and role privilege drift', async () => {
  const source = await observeNativeQualificationSource();
  const input = simulatedFixture(source);
  const catalog = simulatedInstalledCatalog(source);
  catalog.registeredBase.migrations[0].sha256 = '0'.repeat(64);
  catalog.nativeRelations[0].forceRowSecurity = false;
  catalog.nativeRelations[1].runtimePrivileges[0].columnPrivileges = [
    'original_inline_text:SELECT',
  ];
  catalog.runtimeRoles[0].ownerMember = true;
  input.observeCatalog = async () => catalog;
  const owner = createNativeQualificationLifecycle(input);
  const report = await owner.assess(['call_wait_resume']);
  assert.deepEqual(report.compatibility.drift, [
    'registered_base',
    'relation:app.workflow_calls',
    'relation:app.workflow_execution_value_provenance',
    'role:pertexo_api',
  ]);
  assert.equal(report.installedCompatible, false);
  await owner.close();
});

test('rejects observed host-network reuse and additional published endpoints before catalog', async () => {
  for (const change of [
    (row) => {
      row.HostConfig = { Privileged: false, NetworkMode: 'host' };
    },
    (row) => {
      row.HostConfig = { Privileged: true, NetworkMode: 'bridge' };
    },
    (row) => {
      row.HostConfig = {
        Privileged: false,
        NetworkMode: `container:${'c'.repeat(64)}`,
      };
    },
    (row) => {
      row.NetworkSettings.Ports['8080/tcp'] = [
        { HostIp: '0.0.0.0', HostPort: '8080' },
      ];
    },
  ]) {
    const input = simulatedFixture(await observeNativeQualificationSource());
    change(input.rows.get(input.expectedResources.postgresId));
    let observed = false;
    input.observeCatalog = async () => {
      observed = true;
      return { nativeFunctions: [] };
    };
    const owner = createNativeQualificationLifecycle(input);
    await assert.rejects(
      owner.assess(['call_wait_resume']),
      /network or endpoint isolation/u,
    );
    assert.equal(observed, false);
    await assert.rejects(owner.close(), /cleanup failed/u);
    assert.equal(input.disposed.length, 0);
  }
});

test('rejects malformed, duplicate and unknown catalog section identities', async () => {
  const changes = [
    (catalog) => {
      catalog.nativeRelations = {};
    },
    (catalog) => {
      catalog.nativeRelations.push(catalog.nativeRelations[0]);
    },
    (catalog) => {
      catalog.nativeRelations[0].name = 'app.other';
    },
    (catalog) => {
      delete catalog.runtimeRoles[0].ownerMember;
    },
    (catalog) => {
      catalog.nativeRelations[0].runtimePrivileges[0].role = 'caller_chosen';
    },
    (catalog) => {
      catalog.registeredBase.migrations.push(
        catalog.registeredBase.migrations[0],
      );
    },
    (catalog) => {
      catalog.registeredBase.migrations[0].sha256 = 'not-a-digest';
    },
  ];
  const source = await observeNativeQualificationSource();
  for (const change of changes) {
    const input = simulatedFixture(source);
    const catalog = simulatedInstalledCatalog(source);
    change(catalog);
    input.observeCatalog = async () => catalog;
    const owner = createNativeQualificationLifecycle(input);
    await assert.rejects(owner.assess(['call_wait_resume']), /Malformed/u);
    await owner.close();
  }
});

test('matching known sections cannot fill unavailable installed or dedicated-isolation facts', async () => {
  const source = await observeNativeQualificationSource();
  const input = simulatedFixture(source);
  // Copy bound source into a simulated observation, never derive expectations from observations.
  input.observeCatalog = async () => ({
    ...simulatedInstalledCatalog(source),
    compatible: true,
  });
  for (const row of input.rows.values())
    row.HostConfig = { Privileged: false, NetworkMode: 'bridge' };
  const owner = createNativeQualificationLifecycle(input);
  const report = await owner.assess(['call_wait_resume']);
  assert.deepEqual(report.compatibility.drift, []);
  assert.equal(report.compatibility.missingFacts.length, 5);
  assert.equal(report.compatibility.complete, false);
  assert.equal(report.compatibility.dedicatedTargetVerified, false);
  assert.equal(report.installedCompatible, false);
  assert.equal(report.runtimeStartAuthorized, false);
  await owner.close();
});

test('rejects null, unknown, extra and reordered purge configuration observations exactly', async () => {
  const signature =
    'app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,character)';
  const configurations = [
    null,
    undefined,
    ['search_path=pg_catalog, app, pg_temp', 'row_security=on'],
    [
      'search_path=pg_catalog, pg_temp',
      'row_security=on',
      'statement_timeout=0',
    ],
    ['row_security=on', 'search_path=pg_catalog, pg_temp'],
  ];
  for (const proconfig of configurations) {
    const input = simulatedFixture(await observeNativeQualificationSource());
    input.observeCatalog = async () => ({
      nativeFunctions: simulatedNativeFunctions(input.source).map((row) => ({
        ...row,
        ...(row.signature === signature ? { proconfig } : {}),
      })),
    });
    const owner = createNativeQualificationLifecycle(input);
    const report = await owner.assess(['retention_family_resume']);
    assert.deepEqual(report.nativeOwnerDrift, [signature]);
    await owner.close();
  }
});

test('binds a separate complete volatility profile without changing existing body/configuration identities', async () => {
  const source = await observeNativeQualificationSource();
  const profile = source.nativeFunctionVolatility;
  assert.equal(profile.length, 70);
  assert.deepEqual(
    profile.map((row) => row.signature),
    NATIVE_COORDINATOR_OWNER_INVENTORY.map((row) => row.signature),
  );
  assert.deepEqual(
    profile.filter((row) => row.volatility === 'i'),
    [
      {
        signature: 'app.native_execution_value_binary64_leaf(text)',
        volatility: 'i',
      },
    ],
  );
  assert.deepEqual(
    profile.filter((row) => row.volatility === 's'),
    [
      {
        signature:
          'app.native_node_accepted_output(uuid,uuid,uuid,character varying,uuid,jsonb)',
        volatility: 's',
      },
      {
        signature:
          'app.standard_retention_dry_run_stage_keys(uuid,character varying,character varying,timestamptz,jsonb,jsonb,boolean,integer)',
        volatility: 's',
      },
    ],
  );
  assert.equal(profile.filter((row) => row.volatility === 'v').length, 67);
  assert.equal(
    source.functionVolatilitySha256,
    createHash('sha256').update(JSON.stringify(profile)).digest('hex'),
  );
  assert.equal(
    source.functionVolatilitySha256,
    '7255cb74a80d0054726f2fcf102f136bc60c5c1db7e14787047843c5553e6ba8',
  );
});

test('rejects missing, null, unknown and changed volatility observations without creating runtime admission', async () => {
  const source = await observeNativeQualificationSource();
  const cases = [
    ['app.read_workflow_call_run_family(uuid)', undefined],
    ['app.read_workflow_call_run_family(uuid)', null],
    ['app.read_workflow_call_run_family(uuid)', 'VOLATILE'],
    ['app.read_workflow_call_run_family(uuid)', 's'],
    ['app.native_execution_value_binary64_leaf(text)', 'v'],
    [
      'app.standard_retention_dry_run_stage_keys(uuid,character varying,character varying,timestamptz,jsonb,jsonb,boolean,integer)',
      'v',
    ],
  ];
  for (const [signature, volatility] of cases) {
    const input = simulatedFixture(source);
    input.observeCatalog = async () => ({
      nativeFunctions: simulatedNativeFunctions(source).map((row) =>
        row.signature === signature ? { ...row, volatility } : row,
      ),
    });
    const owner = createNativeQualificationLifecycle(input);
    const report = await owner.assess(['retention_family_resume']);
    assert.deepEqual(report.nativeOwnerDrift, [signature]);
    assert.equal(report.installedCompatible, false);
    assert.equal(report.nativeReady, false);
    assert.equal(report.runtimeStartAuthorized, false);
    assert.ok(
      report.compatibility.missingFacts.some(
        (row) => row.id === 'complete_function_acl',
      ),
    );
    await owner.close();
  }
});
