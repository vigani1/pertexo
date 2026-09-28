import { readFile } from 'node:fs/promises';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { databaseSchema } from '../src/schema.js';

const migration = await readFile(
  new URL('../migrations/0120_workspace_inbox_foundation.sql', import.meta.url),
  'utf8',
);

describe('workspace inbox additive foundation (static evidence only)', () => {
  it.each([
    'workspaceInboxSources',
    'workspaceInboxAudience',
    'workspaceInboxRecipientState',
    'workspaceInboxEntries',
  ] as const)('owns %s with tenant-first indexes/keys', (name) => {
    const config = getTableConfig(databaseSchema[name]);
    expect(migration).toContain(`CREATE TABLE app.${config.name}`);
    expect(
      config.columns.find((column) => column.name === 'workspace_id')?.notNull,
    ).toBe(true);
    expect(config.foreignKeys.length).toBeGreaterThan(0);
  });
  it('preserves PostgreSQL timestamp and bigint precision in the typed schema', () => {
    const sources = databaseSchema.workspaceInboxSources;
    expect(
      sources.occurredAt.mapFromDriverValue('2026-09-28 10:00:00.000123+00'),
    ).toBe('2026-09-28 10:00:00.000123+00');
    expect(
      sources.terminalEventSequence.mapFromDriverValue('9007199254740993'),
    ).toBe(9007199254740993n);
  });
  it('declares forced RLS and separate API-recipient/projection authority', () => {
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('SECURITY INVOKER');
    expect(migration).toContain(
      "membership.role IN ('owner','admin','operator')",
    );
    expect(migration).toContain("recipient.status='active'");
    expect(migration).toContain("workspace.status='active'");
    expect(migration).toContain("current_setting('app.actor_id',true)");
    expect(migration).toContain('expires_at>statement_timestamp()');
    expect(migration).not.toMatch(/GRANT (?:ALL|DELETE|TRUNCATE)/u);
    expect(migration).not.toContain('BYPASSRLS');
  });
  it('makes source identity/horizons immutable to column-update grants', () => {
    expect(migration).toContain('workspace_inbox_sources_terminal_unique');
    expect(migration).toContain("expires_at=occurred_at+interval '720 hours'");
    expect(migration).toContain(
      "evidence_until=occurred_at+interval '2160 hours'",
    );
    const update =
      /GRANT UPDATE \(([^)]+)\)\s+ON app.workspace_inbox_sources/u.exec(
        migration,
      )?.[1];
    expect(update).toBeDefined();
    for (const immutable of [
      'occurred_at',
      'evidence_until',
      'run_id',
      'checksum',
    ])
      expect(update).not.toContain(immutable);
    expect(update?.split(',').map((column) => column.trim())).not.toContain(
      'expires_at',
    );
  });
  it('keeps dedupe and first-read time protections without raw payload columns', () => {
    expect(migration).toContain(
      'workspace_inbox_entries_source_recipient_unique',
    );
    expect(migration).toContain(
      'workspace_inbox_entries_recipient_revision_unique',
    );
    expect(migration).toContain('NEW.read_at:=OLD.read_at');
    expect(migration).toContain('NEW.read_at:=clock_timestamp()');
    expect(migration).not.toContain(' jsonb');
    expect(migration).not.toContain('GRANT UPDATE ON');
  });
  it('patches the existing guarded purge child-first before run deletion', () => {
    expect(migration).toContain(
      "v_definition:=replace(v_definition,'''workflow_runs'''",
    );
    expect(migration).toContain(
      "'''workspace_inbox_entries'', ''workspace_inbox_audience'', ''workspace_inbox_recipient_state'', ''workspace_inbox_sources'', ''workflow_runs'''",
    );
    expect(migration).not.toContain('ON DELETE CASCADE');
    expect(migration).not.toContain(
      'CREATE TABLE app.workspace_inbox_read_all',
    );
  });
});
