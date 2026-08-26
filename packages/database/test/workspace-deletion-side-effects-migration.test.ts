import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../migrations/0049_workspace_deletion_side_effects.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('workspace deletion side effects migration', () => {
  it('binds access, trigger, connection, and run cancellation to projection', () => {
    expect(migration).toContain(
      'CREATE FUNCTION app.apply_workspace_deletion_side_effects()',
    );
    expect(migration).toContain("SET status='reauthorization_required'");
    expect(migration).toContain("SET status='disabled'");
    expect(migration).toContain("activation_status='inactive'");
    expect(migration).toContain('failure_notification_destinations');
    expect(migration).toContain("status='canceled'");
    expect(migration).toContain("'run.cancel_requested'");
    expect(migration).toContain("'run.canceled'");
    expect(migration).toContain("interval '5 minutes'");
    expect(migration).toContain("'{cancelRequested}','true'::jsonb");
    expect(migration).toContain("'advance-workflow-run'");
    expect(migration).toContain('workspaces_apply_deletion_side_effects');
    expect(migration).toContain(
      'CREATE FUNCTION app.require_active_workspace_integration()',
    );
  });
});
