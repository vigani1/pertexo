import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { hasCapability } from '../src/tenant-access/workspace-policy.js';

const sql = await readFile(
  new URL('../migrations/0122_workspace_inbox_projection.sql', import.meta.url),
  'utf8',
);
const readiness = await readFile(
  new URL(
    '../src/execution/workspace-inbox/projection-readiness.ts',
    import.meta.url,
  ),
  'utf8',
);
const captureReadiness = await readFile(
  new URL(
    '../src/execution/workspace-inbox/capture-readiness.ts',
    import.meta.url,
  ),
  'utf8',
);
const definitions = [
  ...sql.matchAll(
    /CREATE (?:OR REPLACE )?FUNCTION app\.([a-z_]+)\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/gu,
  ),
];
const body = (name: string) =>
  definitions.find((match) => match[1] === name)?.[2] ?? '';
describe('inactive projection SQL/readiness (static evidence, not PostgreSQL execution)', () => {
  it('pins all effective bodies and grants without modifying historical capture bodies', () => {
    expect(definitions).toHaveLength(5);
    for (const definition of definitions) {
      const name = definition[1] ?? '',
        hash = createHash('md5')
          .update(definition[2] ?? '')
          .digest('hex');
      expect(
        name.includes('capture') || name.includes('validate')
          ? captureReadiness
          : readiness,
      ).toContain(hash);
      expect(sql).toContain('ALTER FUNCTION app.' + name);
    }
    expect(sql).not.toContain(
      'CREATE OR REPLACE FUNCTION app.capture_workspace_inbox_audience',
    );
    expect(sql).not.toContain(
      'CREATE OR REPLACE FUNCTION app.fail_workspace_inbox_capture',
    );
    expect(sql).not.toContain(
      'CREATE OR REPLACE FUNCTION app.workspace_inbox_source_checksum',
    );
    expect(sql).toContain(
      'FROM PUBLIC,{{api_runtime_role}},{{worker_runtime_role}},{{dispatcher_role}}',
    );
    expect(readiness).toContain('has_column_privilege');
    expect(readiness).toContain('relation.relforcerowsecurity');
  });
  it('selects a bounded saved candidate set before shared participant locks and rechecks once', () => {
    const page = body('project_workspace_inbox_page');
    expect(page.match(/LIMIT 100/gu)).toHaveLength(2);
    const candidate = page.indexOf('INTO v_candidates');
    const users = page.indexOf('PERFORM id FROM app.users');
    const members = page.indexOf(
      'PERFORM user_id FROM app.workspace_memberships',
    );
    const source = page.indexOf('SELECT * INTO v_source');
    const recheck = page.indexOf('INTO v_rechecked');
    const audience = page.indexOf(
      'PERFORM user_id FROM app.workspace_inbox_audience',
    );
    expect(candidate).toBeGreaterThan(0);
    expect(users).toBeGreaterThan(candidate);
    expect(members).toBeGreaterThan(users);
    expect(source).toBeGreaterThan(members);
    expect(recheck).toBeGreaterThan(source);
    expect(audience).toBeGreaterThan(recheck);
    expect(page).toContain('v_rechecked IS DISTINCT FROM v_candidates');
    expect(page).toContain(
      "RAISE EXCEPTION 'inbox projection checkpoint mismatch'",
    );
    expect(page).not.toContain('SKIP LOCKED');
    expect(page.match(/FOREACH/gu)).toHaveLength(1);
    expect(page.slice(source)).not.toContain('FOR SHARE');
  });
  it('uses current eligibility, not observed role revision equality, and preserves atomic progress', () => {
    const page = body('project_workspace_inbox_page');
    expect(page).toContain("membership.role IN ('owner','admin','operator')");
    for (const role of ['owner', 'admin', 'operator'] as const)
      expect(hasCapability(role, 'run:read')).toBe(true);
    expect(page).toContain("membership.status='active'");
    expect(page).toContain("recipient.status='active'");
    expect(page).not.toContain('observed_role_revision');
    expect(page.indexOf('revision=revision+1')).toBeLessThan(
      page.indexOf('INSERT INTO app.workspace_inbox_entries'),
    );
    expect(page).toContain("SET status='skipped'");
    expect(page).toContain("SET status='inserted'");
    expect(page).toContain('consecutive_attempts=0');
    expect(page).not.toContain('UPDATE app.workspace_inbox_entries');
  });
  it('checks fresh expiry after all decisions before checkpoint, with fixed retry/lease bounds', () => {
    const page = body('project_workspace_inbox_page');
    expect(page.indexOf('v_finished:=clock_timestamp()')).toBeGreaterThan(
      page.indexOf('END LOOP;'),
    );
    expect(page).toContain(
      'v_finished>=v_source.expires_at OR v_finished>=v_source.lease_expires_at',
    );
    expect(page).toContain("v_created+interval '720 hours'");
    expect(sql).toContain("interval '30 seconds'");
    expect(sql).toContain('consecutive_attempts>=10');
    expect(sql).toContain('0.5+random()*0.5');
    expect(sql).not.toContain("interval '90 days'");
  });
  it('revokes each raw mutation seam and provides no producer/runtime/activation', () => {
    expect(sql).toContain(
      'REVOKE INSERT ON app.workspace_inbox_audience,app.workspace_inbox_recipient_state,app.workspace_inbox_entries',
    );
    expect(sql).toContain('REVOKE UPDATE(status,processed_at)');
    expect(sql).toContain('REVOKE UPDATE(revision)');
    expect(sql).toContain(
      'REVOKE UPDATE(status,captured_at,audience_count,last_recipient_user_id',
    );
    expect(sql).not.toContain('CREATE TABLE');
    expect(sql).not.toContain('INSERT INTO app.outbox_events');
    expect(sql).not.toContain('GRANT SELECT ON app.users');
    expect(sql).not.toMatch(/CREATE FUNCTION app\.[a-z_]*activat/iu);
  });
});
