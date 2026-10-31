import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createGovernanceStore } from '@pertexo/database/governance';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import {
  apiUrl,
  actorId,
  workspaceId,
  queryAsOwner,
} from '../../../database/test/support/workflow-authoring.js';
import { createWorkspaceVariablesStore } from '../../src/variables/index.js';
const scope = () => ({ actorId, workspaceId });
let store: ReturnType<typeof createGovernanceStore>;
beforeAll(() => {
  store = createGovernanceStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
  );
});
afterAll(() => store.close());
it('keeps valid full variable replacements inside the audit metadata budget', async () => {
  const variables = createWorkspaceVariablesStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
  );
  const names = (prefix: string) =>
    Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [
        `${prefix}${'X'.repeat(60)}${String(index).padStart(3, '0')}`,
        'PRIVATE_VARIABLE_VALUE',
      ]),
    );
  try {
    const initial = await variables.read(scope());
    const first = await variables.replace({
      ...scope(),
      expectedRevision: initial.revision,
      values: names('A'),
      idempotencyKey: randomUUID(),
    });
    const result = await variables.replace({
      ...scope(),
      expectedRevision: first.revision,
      values: names('B'),
      idempotencyKey: randomUUID(),
    });
    const audit = await store.list({
      ...scope(),
      query: { action: 'workspace.variables_changed', limit: 50 },
    });
    const event = audit.items.find(
      (item) => item.metadata.revision === result.revision,
    );
    expect(event?.metadata).toMatchObject({
      changedCount: 200,
      changedNamesTruncated: true,
    });
    expect(event?.metadata.changedNames).toHaveLength(100);
    expect(JSON.stringify(audit)).not.toContain('PRIVATE_VARIABLE_VALUE');
    const stored = await queryAsOwner<{ bytes: number }>(
      "select octet_length(metadata::text)::int bytes from app.audit_events where workspace_id=$1 and action='workspace.variables_changed' and metadata->>'revision'=$2",
      [workspaceId, String(result.revision)],
      workspaceId,
    );
    expect(stored[0]?.bytes).toBeLessThanOrEqual(8192);
  } finally {
    await variables.close();
  }
});
