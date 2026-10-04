import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
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
    }));
    expect(NATIVE_COORDINATOR_OWNER_INVENTORY).toEqual(expected);
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
