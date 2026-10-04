import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { checkNativeCoordinatorReadiness } from '../src/execution/coordinator/coordinator-native-readiness.js';
import {
  NATIVE_COORDINATOR_OWNER_INVENTORY,
  UNFINISHED_NATIVE_OWNER_INTEGRATIONS,
} from '../src/execution/coordinator/coordinator-native-owner-inventory.js';
import { NATIVE_PUBLISHED_CONSTRAINT_INVENTORY } from '../src/execution/coordinator/coordinator-native-published-constraints.js';

/** Source review tripwires only. This suite never installs or qualifies SQL. */
describe('unregistered native retention source contracts', () => {
  let candidate: string;
  let registered: string;
  const bodies = (sql: string) => [
    ...sql.matchAll(
      /CREATE (?:OR REPLACE )?FUNCTION app\.(\w+)\(([\s\S]*?)\)\s*(RETURNS[\s\S]*?)AS \$\$([\s\S]*?)\$\$;/gu,
    ),
  ];
  const group = (
    match: RegExpMatchArray | undefined,
    index: number,
  ): string => {
    const value = match?.[index];
    if (value === undefined)
      throw new Error('Expected complete SQL source body');
    return value;
  };
  const body = (sql: string, name: string) => {
    const matches = bodies(sql).filter((match) => match[1] === name);
    expect(matches).toHaveLength(1);
    return group(matches[0], 4);
  };
  beforeAll(async () => {
    [candidate, registered] = await Promise.all([
      readFile(
        new URL(
          '../src/execution/workflow-calls/0137-native-execution-values.candidate.sql',
          import.meta.url,
        ),
        'utf8',
      ),
      readFile(
        new URL(
          '../migrations/0076_replay_lineage_retention.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    ]);
  });

  it('keeps installation aborted before any schema mutation', () => {
    expect(
      candidate.indexOf("RAISE EXCEPTION 'Unregistered F08 0137"),
    ).toBeLessThan(candidate.indexOf('ALTER TABLE'));
    expect(candidate).not.toContain('ON DELETE SET NULL');
    expect(UNFINISHED_NATIVE_OWNER_INTEGRATIONS.length).toBeGreaterThan(0);
  });

  it('preserves the reviewed purge search path without adding app or inheriting configuration', () => {
    const purge = NATIVE_COORDINATOR_OWNER_INVENTORY.find(
      (row) =>
        row.signature ===
        'app.execute_workspace_tenant_rows_page(uuid,uuid,bigint,integer,bigint,character)',
    );
    expect(purge?.proconfig).toEqual([
      'search_path=pg_catalog, pg_temp',
      'row_security=on',
    ]);
  });

  it('passes exact per-function configuration to readiness without subset or null acceptance', async () => {
    const readiness = await readFile(
      new URL(
        '../src/execution/coordinator/coordinator-native-readiness.ts',
        import.meta.url,
      ),
      'utf8',
    );
    expect(readiness).toContain(
      'expected(signature text,hash text,"securityDefiner" boolean,proconfig text[])',
    );
    expect(readiness).toContain('or expected.proconfig is null');
    expect(readiness).toContain(
      'or command.proconfig is distinct from expected.proconfig',
    );
    expect(readiness).not.toContain('case when expected."rowSecurity"');
    expect(readiness).not.toMatch(/command\.proconfig\s*(?:@>|<@|&&)/u);
    expect(readiness).toMatch(
      /\[\s*ownerRole,\s*workerRole,\s*JSON.stringify\(NATIVE_COORDINATOR_OWNER_INVENTORY\),\s*JSON.stringify\(NATIVE_PUBLISHED_CONSTRAINT_INVENTORY\)/u,
    );
  });

  it('still refuses before catalog checkout with all four integration blockers and the unqualified constraint', async () => {
    const connect = vi.fn();
    const pool = {
      options: { connectionTimeoutMillis: 100 },
      connect,
    } as unknown as Pool;
    expect(UNFINISHED_NATIVE_OWNER_INTEGRATIONS).toHaveLength(4);
    expect(
      NATIVE_PUBLISHED_CONSTRAINT_INVENTORY[0].qualifiedExpressionMd5,
    ).toBeNull();
    await expect(
      checkNativeCoordinatorReadiness(
        pool,
        'pertexo_owner',
        'pertexo_worker',
        200,
      ),
    ).rejects.toThrow('Native coordinator owner inventory is incomplete');
    expect(connect).not.toHaveBeenCalled();
  });

  it('widens the actual published-version constraint, not just the draft format, while refusing unqualified readiness', async () => {
    const registeredAuthoring = await readFile(
      new URL('../migrations/0012_workflow_authoring.sql', import.meta.url),
      'utf8',
    );
    expect(registeredAuthoring).toContain(
      'CONSTRAINT workflow_versions_schema_version_supported CHECK (schema_version = 1)',
    );
    const expected = NATIVE_PUBLISHED_CONSTRAINT_INVENTORY[0];
    expect(candidate).toContain(
      'DROP CONSTRAINT workflow_versions_schema_version_supported',
    );
    expect(candidate).toContain(expected.sourceDefinition);
    expect(
      createHash('sha256').update(expected.sourceDefinition).digest('hex'),
    ).toBe(expected.sourceSha256);
    expect(expected.qualifiedExpressionMd5).toBeNull();
    expect(expected.sourceDefinition).toContain('schema_version=1');
    expect(expected.sourceDefinition).toContain(
      "schema_version=2 AND graph_json->'schemaVersion'='2'::jsonb",
    );
    expect(expected.sourceDefinition).toContain(
      "executable_json->'schemaVersion'='3'::jsonb",
    );
    expect(expected.sourceDefinition).toContain(
      "(graph_json->'callable') IS NOT DISTINCT FROM (executable_json#>'{graph,callable}')",
    );
    // Actual compiled graphs intentionally omit an authoring schema label.
    expect(expected.sourceDefinition).not.toContain('{graph,schemaVersion}');
  });

  it('keeps read proof non-mutating and mutating proof ancestor-first with a final current reread', () => {
    const proof = body(candidate, 'native_attempt_value_owner');
    expect(proof).not.toMatch(
      /FOR (?:UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)|\b(?:INSERT|DELETE|UPDATE|set_config)\b/u,
    );
    const writer = body(candidate, 'lock_native_attempt_value_owner');
    expect(writer.indexOf('FOR v_index IN REVERSE')).toBeLessThan(
      writer.indexOf("receipt.consumer_name='node-attempt-worker'"),
    );
    expect(
      writer.indexOf("receipt.consumer_name='node-attempt-worker'"),
    ).toBeLessThan(writer.indexOf('FROM app.node_runs node'));
    expect(writer.indexOf('FROM app.node_runs node')).toBeLessThan(
      writer.indexOf('FROM app.node_attempts attempt'),
    );
    expect(
      writer.lastIndexOf('RETURN app.native_attempt_value_owner(p_authority)'),
    ).toBeGreaterThan(writer.indexOf('FROM app.node_attempts attempt'));
    expect(body(candidate, 'read_native_attempt_value_source')).toContain(
      'app.native_attempt_value_owner(p_authority)',
    );
  });

  it('exposes complete final registered bodies with exact prior-body drift checks', () => {
    for (const name of [
      'execute_standard_retention_page',
      'standard_retention_dry_run_stage_keys',
    ]) {
      const prior = body(registered, name);
      expect(candidate).toContain(
        createHash('md5').update(prior).digest('hex'),
      );
      expect(body(candidate, name)).toContain('BEGIN');
      expect(body(candidate, name).trimEnd()).toMatch(/END$/u);
    }
    expect(candidate).not.toMatch(
      /pg_get_functiondef|replace\(v_(?:body|definition)/u,
    );
  });
  it('derives enclosing collection declarations from current consumer ancestry/branch/active ordinals, not supplied historical selectors', () => {
    const read = body(candidate, 'read_native_attempt_value_source');
    expect(read).toContain(
      "p_selection=jsonb_build_object('slot','structured_collection')",
    );
    expect(read).toContain(
      "invocation->>'status'='running' AND invocation->'attemptNumber'=v_scope->'attemptNumber'",
    );
    expect(read).toContain("declaration->'iterationPath'=");
    expect(read).toContain(
      "jsonb_array_elements(declaration->'branchPath') WITH ORDINALITY",
    );
    expect(read).toContain(
      "declaration->'activeOrdinals' @> jsonb_build_array(v_iteration->'ordinal')",
    );
    expect(read).toContain(
      "v_source.attempt_id::text=v_loop#>>'{collection,attemptId}'",
    );
    expect(read).toContain(
      "v_source.artifact_id::text=v_loop#>>'{collection,artifactId}'",
    );
    expect(read).toContain(
      "node.status='waiting' AND node.control_kind='for_each_barrier'",
    );
    expect(read).toContain(
      "v_metadata:=v_metadata||jsonb_build_object('collection',v_collection)",
    );
    expect(
      read.lastIndexOf('app.native_attempt_value_owner(p_authority)'),
    ).toBeGreaterThan(
      read.indexOf('native structured exact physical declaration differs'),
    );
  });

  it('keeps source body expectations synchronized, without granting readiness', () => {
    const expected = bodies(candidate).map((match) => ({
      signature: `app.${group(match, 1)}(${group(match, 2)
        .replace(/\bp_\w+\s+/gu, '')
        .replace(/char\(64\)/gu, 'character')
        .replace(/varchar\b/gu, 'character varying')
        .replace(/\s+/gu, ' ')
        .trim()
        .replace(/\s*,\s*/gu, ',')})`,
      hash: createHash('md5').update(group(match, 4)).digest('hex'),
      securityDefiner: group(match, 3).includes('SECURITY DEFINER'),
      rowSecurity: group(match, 3).includes('SET row_security=on'),
      proconfig: [
        ...group(match, 3).matchAll(/\bSET\s+([a-z_]+)=([a-z_,]+)/gu),
      ].map(
        (setting) =>
          `${group(setting, 1)}=${group(setting, 2).split(',').join(', ')}`,
      ),
    }));
    expect(NATIVE_COORDINATOR_OWNER_INVENTORY).toEqual(expected);
  });

  it('preserves SQL-owned value contracts and inline binary64 guards while accepting only exact artifact result candidates', () => {
    const writer = body(candidate, 'record_workflow_call_run_result');
    expect(writer).toContain(
      "p_reference->>'kind'='artifact' AND p_reference ? 'artifactId' AND p_original IS NULL",
    );
    expect(writer).toContain('IF v_selected_inline THEN');
    expect(writer).toContain(
      "app.assert_native_callable_value(v_version.executable_json#>'{graph,callable,result}',v_selected)",
    );
    expect(
      writer.indexOf(
        "app.assert_native_callable_value(v_version.executable_json#>'{graph,callable,result}',v_selected)",
      ),
    ).toBeLessThan(
      writer.indexOf(
        'app.assert_native_inline_execution_value_bytes(v_selected',
      ),
    );
    expect(writer).toContain(
      'v_candidate.coordinator_result_identity=v_identity_sha',
    );
    expect(writer).toContain(
      'candidate.expected_revision=p_revision-1 FOR UPDATE',
    );
    expect(writer).toContain('v_candidate.result_revision=p_revision');
    expect(writer).toContain(
      'v_existing.original_inline_text IS NOT DISTINCT FROM p_original',
    );
    expect(writer).toContain(
      'INSERT INTO app.workflow_execution_value_artifact_associations',
    );
    expect(writer).toContain(
      'v_source_until:=least(v_source_until,v_source_artifact_until)',
    );
    const producer = body(candidate, 'lock_native_result_artifact_owner');
    expect(producer.indexOf('app.lock_workspace_run_admission')).toBeLessThan(
      producer.indexOf('app.prelock_native_coordinator_lineage'),
    );
    expect(
      producer.indexOf('FOR NO KEY UPDATE OF run,checkpoint'),
    ).toBeLessThan(producer.indexOf('FROM app.inbox_receipts receipt'));
    expect(
      producer.lastIndexOf(
        'app.inspect_native_coordinator_value_owner(p_owner)',
      ),
    ).toBeGreaterThan(producer.indexOf('FROM app.inbox_receipts receipt'));
    expect(producer).not.toMatch(/\bINSERT\b/u);
    const prepare = body(candidate, 'prepare_native_result_artifact_candidate');
    expect(prepare).toContain(
      "v_candidate.creation_outbox_event_id=(p_owner#>>'{delivery,outboxEventId}')::uuid",
    );
    expect(prepare).toContain(
      'v_candidate.coordinator_result_identity=p_result_identity',
    );
    expect(prepare).not.toMatch(/\bINSERT\b/u);
  });

  it('keeps general-selector dependency inspection application-owned while rederiving each SQL source identity', () => {
    const inventory = body(candidate, 'native_coordinator_value_inventory');
    expect(inventory).toContain('jsonb_array_length(p_node_ids)>1000');
    expect(inventory).toContain('count(DISTINCT entry)');
    expect(inventory).toContain(
      "v_selector->>'language' IS DISTINCT FROM 'jsonata'",
    );
    expect(inventory).toContain(
      "v_selector->'policyVersion' IS DISTINCT FROM '1'::jsonb",
    );
    expect(inventory).toContain('FOR v_selection IN SELECT entry');
    expect(inventory).toContain(
      'v_input:=NULL; v_value:=NULL; v_call:=NULL; v_invocation:=NULL; v_source:=NULL;',
    );
    expect(inventory).toContain("WHERE node->>'id'=v_node_id");
    expect(inventory).toContain(
      "invocation->>'nodeId'=v_node_id AND invocation->>'status' IN ('succeeded','waiting')",
    );
    expect(inventory).toContain(
      'source.original_reference::text=attempt.output_ref::text AND source.original_reference::text=node.output_ref::text',
    );
    expect(inventory).toContain('candidate.abandoned_at IS NULL');
    expect(inventory).toContain('artifact.expires_at>clock_timestamp()');
    expect(inventory).toContain(
      'artifact.sha256=v_value.sha256 AND artifact.byte_length=v_value.byte_length',
    );
    expect(inventory).toContain('v_outputs:=v_outputs||jsonb_build_array');
    const load = body(candidate, 'load_native_coordinator_value_sources');
    expect(
      load.indexOf('app.inspect_native_coordinator_value_owner(p_owner)'),
    ).toBeLessThan(
      load.indexOf(
        'app.native_coordinator_value_inventory(p_owner,v_node_ids)',
      ),
    );
    expect(load).toContain(
      "'resultSelector',v_selector,'requiresRunInput',v_selector->>'kind' IN ('run_input','expression'),'sources',v_expected",
    );
    const read = body(candidate, 'read_native_coordinator_value_source');
    expect(read).toContain(
      "jsonb_build_array(p_descriptor#>'{source,nodeId}')",
    );
    expect(read).toContain('WHERE descriptor=p_descriptor');
    expect(read).toContain('app.assert_native_inline_execution_value_bytes');
    expect(candidate).toContain(
      'REVOKE ALL ON FUNCTION app.native_coordinator_value_inventory(jsonb,jsonb)',
    );
    expect(candidate).not.toContain(
      'GRANT EXECUTE ON FUNCTION app.native_coordinator_value_inventory',
    );
  });

  it('preserves the complete latest purge wrapper and its existing patched delegate chain', async () => {
    const latest = await readFile(
      new URL(
        '../migrations/0135_workflow_folders_batch_identity.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const prior = body(latest, 'execute_workspace_tenant_rows_page');
    const next = body(candidate, 'execute_workspace_tenant_rows_page');
    expect(candidate).toContain(createHash('md5').update(prior).digest('hex'));
    expect(
      next.replace(
        /\n {2}-- BEGIN NATIVE PURGE DEPENDENCIES:[\s\S]*? {2}-- END NATIVE PURGE DEPENDENCIES\.\n/u,
        '',
      ),
    ).toBe(prior);
    expect(next).toContain(
      'app.execute_workspace_tenant_rows_page_before_folders(',
    );
    expect(next).not.toContain(
      'execute_workspace_tenant_rows_page_before_organization(',
    );
  });

  it('purges native dependencies in bounded pages under the actual job/step/control/hold owner', () => {
    const next = body(candidate, 'execute_workspace_tenant_rows_page');
    const start = next.indexOf('-- BEGIN NATIVE PURGE DEPENDENCIES:');
    const end = next.indexOf('-- END NATIVE PURGE DEPENDENCIES.');
    const native = next.slice(start, end);
    expect(start).toBeGreaterThan(
      next.indexOf("RAISE EXCEPTION 'legal hold blocks purge'"),
    );
    expect(next.slice(0, start)).toContain(
      'v_step.lease_token IS DISTINCT FROM p_lease_token',
    );
    expect(next.slice(0, start)).toContain(
      'retention_control_sequence=p_projected_sequence AND retention_control_hash=p_projected_hash',
    );
    const dependencies = [
      'workflow_execution_value_artifact_associations',
      'workflow_execution_value_borrowed_provenance',
      'workflow_calls',
      'workflow_execution_value_owned_provenance',
      'workflow_execution_value_artifact_candidates',
    ];
    expect(dependencies.map((table) => native.indexOf(`'${table}'`))).toEqual(
      [...dependencies.map((table) => native.indexOf(`'${table}'`))].sort(
        (a, b) => a - b,
      ),
    );
    expect(native).toContain('LIMIT p_page_size FOR UPDATE');
    expect(native).toContain('LIMIT $2 FOR UPDATE');
    expect(native).toContain('v_step.lease_expires_at<=clock_timestamp()');
    expect(native).toContain(
      'RETURN QUERY SELECT v_table::varchar,v_count,false; RETURN;',
    );
    expect(native).not.toMatch(
      /DELETE FROM app\.(?:artifacts|workflow_runs|node_attempts)|UPDATE app\.workspace_execution_admission_counters|CASCADE/iu,
    );
  });

  it('preserves complete ordinary registered bodies outside explicit native extensions', () => {
    const standard = body(candidate, 'execute_standard_retention_page')
      .replace(
        / {6}v_count:=app\.execute_native_execution_detail_page\([^;]+;\n {6}IF v_count=0 THEN\n([\s\S]*?) {6}END IF;\n/u,
        '$1',
      )
      .replace(
        / {4}v_count:=app\.execute_native_family_summary_page\([^;]+;\n {4}IF v_count=0 THEN\n([\s\S]*?) {4}END IF;\n/u,
        '$1',
      )
      .replace(
        /^\s+AND app\.native_retention_family_eligible\(run.id,v_batch.cutoff_at,(?:false|true)\)\n/gmu,
        '',
      )
      .replace(
        / {8}AND NOT EXISTS\(SELECT 1 FROM app\.workflow_calls call WHERE call.workspace_id=v_batch.workspace_id\n {10}AND \(call.root_run_id=run.id OR call.parent_run_id=run.id OR call.child_run_id=run.id\)\)\n/u,
        '',
      );
    expect(standard).toBe(body(registered, 'execute_standard_retention_page'));
    const dryRun = body(candidate, 'standard_retention_dry_run_stage_keys')
      .replace(
        "    v_eligible:='app.native_retention_family_eligible(run.id,$2,false)';\n",
        '',
      )
      .replace(' AND app.native_retention_family_eligible(run.id,$2,true)', '');
    expect(dryRun).toBe(
      body(registered, 'standard_retention_dry_run_stage_keys'),
    );
  });

  it('bounds native family metadata and uses existing direct replay dependencies', () => {
    const family = body(candidate, 'native_retention_family_runs');
    expect(family).toContain('LIMIT 65');
    expect(family).toContain('>64');
    expect(family).toContain('>65');
    const eligibility = body(candidate, 'native_retention_family_eligible');
    expect(eligibility).toContain(
      'IF NOT coalesce(v_native,false) THEN RETURN true',
    );
    expect(eligibility).toContain('replay.replay_source_run_id=ANY(v_runs)');
    expect(eligibility).toContain("request.status='pending'");
    expect(eligibility).not.toContain('WITH RECURSIVE');
    expect(candidate).toContain(
      'CREATE INDEX native_pending_replay_retention_idx',
    );
  });

  it('requires actual leases, control high water and legal holds for both page owners', () => {
    for (const name of [
      'execute_native_execution_detail_page',
      'execute_native_family_summary_page',
    ]) {
      const sql = body(candidate, name);
      expect(sql).toContain('p_limit NOT BETWEEN 1 AND 1000');
      expect(sql).toContain('lease_token=p_token');
      expect(sql).toContain('lease_fence=p_fence');
      expect(sql).toContain('retention_control_sequence=p_sequence');
      expect(sql).toContain('hold.released_at IS NULL');
      expect(sql).toContain('FOR UPDATE');
      expect(sql).toContain('lease_expires_at<=clock_timestamp()');
    }
  });

  it('deletes one atomic capped summary family and reports physical rows separately', () => {
    const sql = body(candidate, 'execute_native_family_summary_page');
    expect(sql).toContain(
      'ORDER BY run.completed_at,run.id LIMIT 1 FOR UPDATE',
    );
    expect(sql).toContain('cardinality(v_runs)>65 OR cardinality(v_calls)>64');
    expect(sql).toContain(
      'app.native_retention_family_runs(v_root) IS DISTINCT FROM v_runs',
    );
    expect(sql.indexOf('DELETE FROM app.workflow_calls')).toBeLessThan(
      sql.indexOf('DELETE FROM app.workflow_runs'),
    );
    expect(sql).toContain(
      "'familyUnits',1,'physicalRunRows',v_run_count,'journalRows',v_call_count",
    );
    expect(sql).toContain('RETURN v_run_count');
    expect(sql).not.toMatch(/LIMIT p_limit|p_limit\s*\*/u);
    const standard = body(candidate, 'execute_standard_retention_page');
    expect(standard).toContain('IF v_count=0 THEN');
    expect(standard).toContain(
      'ORDER BY run.completed_at,run.id LIMIT p_page_limit',
    );
  });
});
