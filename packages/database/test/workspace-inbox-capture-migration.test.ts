import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migration = await readFile(
  new URL('../migrations/0121_workspace_inbox_capture.sql', import.meta.url),
  'utf8',
);
const readiness = await readFile(
  new URL(
    '../src/execution/workspace-inbox/capture-readiness.ts',
    import.meta.url,
  ),
  'utf8',
);
describe('inbox capture migration/readiness (static evidence only)', () => {
  it('pins exact owned function bodies including the private checksum', () => {
    const functions = [
      ...migration.matchAll(
        /CREATE FUNCTION app\.([a-z_]+)\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/gu,
      ),
    ];
    expect(functions).toHaveLength(4);
    for (const definition of functions) {
      expect(readiness).toContain(definition[1]);
      expect(readiness).toContain(
        createHash('md5')
          .update(definition[2] ?? '')
          .digest('hex'),
      );
      expect(migration).toContain(`ALTER FUNCTION app.${definition[1] ?? ''}`);
    }
    expect(migration).toContain(
      'FROM PUBLIC,{{api_runtime_role}},{{dispatcher_role}},{{maintenance_role}},{{operator_role}},{{lifecycle_command_role}}',
    );
    expect(migration).toContain('TO {{worker_runtime_role}}');
    expect(migration).not.toMatch(
      /GRANT.*ON app\.(users|workspace_memberships)/u,
    );
  });
  it('locks the active workspace before source ownership in each command', () => {
    for (const body of migration.matchAll(
      /LANGUAGE plpgsql[\s\S]*?AS \$\$([\s\S]*?)\$\$;/gu,
    )) {
      const text = body[1] ?? '';
      expect(text.indexOf('FROM app.workspaces')).toBeLessThan(
        text.indexOf('FROM app.workspace_inbox_sources'),
      );
      expect(text).toContain("current_setting('app.workspace_id',true)");
      expect(text).toContain("v_status<>'active'");
    }
  });
  it('captures an unlimited statement snapshot and marker with fixed lease/budget bounds', () => {
    const capture = migration
      .split('CREATE FUNCTION app.capture_workspace_inbox_audience')[1]
      ?.split('CREATE FUNCTION app.fail_workspace_inbox_capture')[0];
    expect(capture).toContain('WITH audience AS');
    expect(capture).toContain('INSERT INTO app.workspace_inbox_audience');
    expect(capture).toContain('SELECT count(*) INTO v_count FROM audience;');
    expect(capture).toContain('audience_count=v_count');
    expect(capture).not.toMatch(/\bLIMIT\b/u);
    expect(capture).not.toContain('ON CONFLICT');
    expect(migration).toContain("interval '30 seconds'");
    expect(migration).toContain('consecutive_attempts>=10');
    expect(migration).toContain('0.5+random()*0.5');
    expect(migration).toContain('least(300.0,5.0*power');
  });
  it('never enables a producer or rewrites the existing foundation', () => {
    expect(migration).not.toContain('CREATE TABLE');
    expect(migration).not.toContain('INSERT INTO app.outbox_events');
    expect(migration).not.toContain('ALTER TABLE app.workspace_inbox');
    expect(migration).not.toMatch(/CREATE FUNCTION app\.[a-z_]*activat/iu);
  });
  it('checks fresh expiry only after the entire audience insert has completed', () => {
    const capture =
      migration
        .split('CREATE FUNCTION app.capture_workspace_inbox_audience')[1]
        ?.split('CREATE FUNCTION app.fail_workspace_inbox_capture')[0] ?? '';
    const completed = capture.indexOf(
      'SELECT count(*) INTO v_count FROM audience;',
    );
    expect(completed).toBeGreaterThan(-1);
    expect(
      capture.indexOf('v_completed_at:=clock_timestamp();'),
    ).toBeGreaterThan(completed);
    expect(capture).toContain('v_completed_at>=v_source.expires_at');
    expect(capture).toContain('captured_at=v_completed_at');
    expect(capture).not.toContain('statement_timestamp()');
  });
  it('limits missing-evidence no-op to a locked absent source and preserves retained delivery checks', () => {
    const claim =
      migration
        .split('CREATE FUNCTION app.claim_workspace_inbox_capture')[1]
        ?.split('CREATE FUNCTION app.capture_workspace_inbox_audience')[0] ??
      '';
    const absent =
      claim.split('IF v_outbox.id IS NULL THEN')[1]?.split('END IF;')[0] ?? '';
    expect(absent).toContain('FROM app.workspace_inbox_sources');
    expect(absent).toContain('FOR UPDATE');
    expect(absent).toContain(
      "IF NOT FOUND THEN RETURN jsonb_build_object('kind','unavailable');",
    );
    expect(claim).toContain('v_outbox.payload IS DISTINCT FROM v_payload');
    expect(claim).toContain(
      'v_outbox.payload_checksum IS DISTINCT FROM p_checksum',
    );
    expect(claim).toContain("RAISE EXCEPTION 'inbox delivery mismatch'");
  });
});
